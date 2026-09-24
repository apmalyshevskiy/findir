<?php

namespace App\Services\Documents;

use App\Models\Tenant\BalanceItem;
use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentItem;
use App\Services\AnalyticSlots;
use App\Services\Documents\CostCalculatorService;
use Illuminate\Support\Facades\DB;

/**
 * Расходная накладная — outgoing_invoice
 *
 * Шапка:
 *   bi_id          = А300 Клиенты
 *   info_1_id      = Покупатель (partner)
 *   revenue_bi_id  = П587 Доходы     ← скопировано из project при создании
 *   cogs_bi_id     = П588 Себестоимость ← скопировано из project при создании
 *   revenue_item_id = Статья дохода  ← скопировано из project при создании
 *
 * У строк три вида, и проводятся они по-разному.
 *
 * ── Продажа (kind = sale) ────────────────────────────────────────────────
 *
 *   bi_id     = А200 Товары / А240 Продукты
 *   info_1_id = Номенклатура (product)
 *   info_2_id = Склад (department) — только если у счёта есть info_2_type
 *   amount      = сумма продажи (выручка)
 *   amount_cost = себестоимость
 *
 * Операция №1 — Выручка (на сумму item.amount):
 *   Дт  doc.bi_id (А300)      + doc.info_1_id (покупатель)
 *   Кт  doc.revenue_bi_id (П587) — статья дохода, номенклатура и отдел
 *       по слотам, которые счёт объявил (см. place)
 *
 * Операция №2 — Себестоимость (на сумму item.amount_cost, если > 0):
 *   Дт  doc.cogs_bi_id (П588) — тот же набор и то же правило
 *   Кт  item.bi_id (А200/А240)
 *       info_1 = item.info_1_id  (номенклатура)
 *       info_2 = item.info_2_id  (склад, если А200)
 *
 * Номера слотов нигде не зашиты: счёт сам объявляет, какой справочник он
 * принимает в каком слоте, — проводка это читает. Справочника, под который
 * слота нет, в проводке не будет вовсе.
 *
 * ── Оплата (kind = payment) ──────────────────────────────────────────────
 *
 * Чем закрыли долг покупателя: наличными в кассу, картой через банк-эквайер,
 * агрегатором. Розничная смена даёт их несколько, и каждая — своя строка.
 *
 *   Дт  item.bi_id (А100 Касса / А300 Банк) + аналитика строки
 *   Кт  doc.bi_id (А300) + doc.info_1_id (покупатель)
 *
 * ── Налог (kind = vat) ───────────────────────────────────────────────────
 *
 * Начисление налога с продажи. В отличие от оплаты, долг покупателя не
 * закрывает, поэтому корреспонденцию задаёт сама строка целиком.
 *
 *   Дт  item.bi_id (П589 Расходы) + item.info_1_id (статья расхода)
 *   Кт  item.head_bi_id (П340 Государство) + item.head_info_1_id
 *
 * Итог документа (`amount`) считается только по строкам продажи: оплаты и
 * налог — не вторая выручка, а её судьба.
 */
class OutgoingInvoiceStrategy implements DocumentStrategyInterface
{
    public function buildOperations(Document $document): array
    {
        $document->loadMissing('items');

        $operations = [];
        $content    = $this->buildContent($document);

        $this->fillMissingCosts($document);

        foreach ($document->items as $item) {
            $itemContent = $item->content ?? $content;

            $operations = match ($this->kindOf($item)) {
                DocumentItem::KIND_PAYMENT => array_merge($operations, $this->payment($document, $item, $itemContent)),
                DocumentItem::KIND_VAT     => array_merge($operations, $this->vat($document, $item, $itemContent)),
                default                    => array_merge($operations, $this->sale($document, $item, $itemContent)),
            };
        }

        return $operations;
    }

    /** Вид строки: пусто означает продажу — так было до появления оплат */
    private function kindOf($item): string
    {
        return $item->kind ?: DocumentItem::KIND_SALE;
    }

    private function isSale($item): bool
    {
        return $this->kindOf($item) === DocumentItem::KIND_SALE;
    }

    /**
     * Себестоимость строк, где её не проставили.
     *
     * Если уже заполнена вручную или пришла из кассы — оставляем как есть.
     * Считаем только продажи: у оплаты себестоимости не бывает, а прогонять
     * её через расчёт остатков значило бы искать склад там, где его нет.
     */
    private function fillMissingCosts(Document $document): void
    {
        if (!$document->cogs_bi_id || $document->items->isEmpty()) return;

        $itemsForCalc = $document->items
            ->filter(fn($i) => $this->isSale($i) && (!$i->amount_cost || $i->amount_cost <= 0))
            ->map(fn($i) => [
                'bi_id'     => $i->bi_id,
                'info_1_id' => $i->info_1_id,
                'info_2_id' => $i->info_2_id,
                'info_3_id' => $i->info_3_id,
                'quantity'  => $i->quantity,
                '_item_id'  => $i->id,
            ])->values()->toArray();

        if (empty($itemsForCalc)) return;

        $costs = CostCalculatorService::calculate(
            $document->getConnectionName(),
            $document->date->format('Y-m-d H:i:s'),
            $document->project_id,
            $itemsForCalc
        );

        // Индексируем по item_id для быстрого поиска
        $costByItemId = [];
        foreach ($itemsForCalc as $idx => $calcItem) {
            if (isset($costs[$idx])) {
                $costByItemId[$calcItem['_item_id']] = $costs[$idx];
            }
        }

        foreach ($document->items as $item) {
            if (isset($costByItemId[$item->id])) {
                $item->amount_cost = $costByItemId[$item->id]['amount_cost'];
                $item->save();
            }
        }

        // Перезагружаем строки с обновлёнными значениями
        $document->load('items');
    }

    /** Выручка и себестоимость одной проданной позиции */
    private function sale(Document $document, $item, string $content): array
    {
        $operations = [];
        $qty        = (float) ($item->quantity ?? 0);

        if ($document->revenue_bi_id) {
            $revenue = [
                'amount'   => (float) $item->amount,
                'quantity' => $qty,

                'in_bi_id'     => $document->bi_id,
                'in_info_1_id' => $document->info_1_id,
                'in_quantity'  => $qty,

                'out_bi_id' => $document->revenue_bi_id,
            ];
            $this->place($document, $revenue, 'out', $document->revenue_bi_id, [
                $document->revenue_item_id,
                $item->info_1_id,
                $document->department_id,
            ]);

            $operations[] = $this->operation($document, $revenue, $content, $item->note);
        }

        if ($document->cogs_bi_id && $item->amount_cost && $item->amount_cost > 0) {
            $cost = [
                'amount'   => (float) $item->amount_cost,
                'quantity' => $qty,

                'in_bi_id'    => $document->cogs_bi_id,
                'in_quantity' => $qty,

                // Кредит — счёт самой строки, и её аналитика выбиралась прямо
                // под него: раскладывать заново нечего
                'out_bi_id'     => $item->bi_id,
                'out_info_1_id' => $item->info_1_id,
                'out_info_2_id' => $item->info_2_id,
                'out_info_3_id' => $item->info_3_id,
                'out_quantity'  => $qty,
            ];
            $this->place($document, $cost, 'in', $document->cogs_bi_id, [
                $document->revenue_item_id,
                $item->info_1_id,
                $document->department_id,
            ]);

            $operations[] = $this->operation($document, $cost, 'Себестоимость: ' . $content, $item->note);
        }

        return $operations;
    }

    /** Оплата: приход денег или требования к банку против долга покупателя */
    private function payment(Document $document, $item, string $content): array
    {
        if (!$item->amount) return [];

        return [$this->operation($document, [
            'amount' => (float) $item->amount,

            'in_bi_id'     => $item->bi_id,
            'in_info_1_id' => $item->info_1_id,
            'in_info_2_id' => $item->info_2_id,
            'in_info_3_id' => $item->info_3_id,

            'out_bi_id'     => $item->head_bi_id ?: $document->bi_id,
            'out_info_1_id' => $item->head_info_1_id ?: $document->info_1_id,
        ], $content, $item->note)];
    }

    /** Налог с продажи: начисление в расходы против обязательства */
    private function vat(Document $document, $item, string $content): array
    {
        if (!$item->amount || !$item->head_bi_id) return [];

        $vat = [
            'amount' => (float) $item->amount,

            'in_bi_id' => $item->bi_id,

            'out_bi_id'     => $item->head_bi_id,
            'out_info_1_id' => $item->head_info_1_id,
            'out_info_2_id' => $item->head_info_2_id,
        ];
        // Налог с продажи — расход отдела наравне с себестоимостью
        $this->place($document, $vat, 'in', $item->bi_id, [
            $item->info_1_id,
            $item->info_2_id,
            $document->department_id,
        ]);

        return [$this->operation($document, $vat, $content, $item->note)];
    }

    /**
     * Аналитика стороны проводки — по слотам, которые счёт сам объявил.
     *
     * Раньше позиции были записаны здесь жёстко: статья дохода в первый слот,
     * номенклатура во второй. Счёт при этом не спрашивали, и настройка плана
     * счетов ни на что не влияла. Если счёт доходов объявлял в первом слоте
     * отдел, туда всё равно ложилась статья дохода, а номенклатура уезжала во
     * второй слот, которого у счёта нет вовсе.
     *
     * Теперь у каждого значения спрашивается вид его справочника и слот
     * ищется под этот вид. **Не нашлось — значение не пишется**: пустой
     * разрез честнее, чем разрез не тем справочником, и отчёты такой слот всё
     * равно не сгруппируют.
     *
     * Порядок перечисления значим: слоты разбираются в нём, поэтому первой
     * идёт статья, потом номенклатура, потом отдел. Занятый слот не
     * перетирается — значению ищется следующий подходящий.
     *
     * @param string          $side 'in' или 'out'
     * @param array<int, ?int> $ids  элементы справочника в порядке важности
     */
    private function place(Document $document, array &$op, string $side, ?int $biId, array $ids): void
    {
        $account = $biId ? $this->account($document, (int) $biId) : null;
        if (!$account) return;

        foreach ($ids as $id) {
            if (!$id) continue;

            foreach (AnalyticSlots::slotsFor($account, $this->infoType($document, (int) $id)) as $slot) {
                $field = "{$side}_info_{$slot}_id";
                if (!empty($op[$field])) continue;

                $op[$field] = (int) $id;
                break;
            }
        }
    }

    /** Счёт из плана. Читаем по одному разу на документ: строк бывает много */
    private function account(Document $document, int $biId)
    {
        if (!isset($this->accounts[$biId])) {
            $this->accounts[$biId] = BalanceItem::on($document->getConnectionName())->find($biId);
        }

        return $this->accounts[$biId];
    }

    /** Вид справочника у элемента — по нему и подбирается слот */
    private function infoType(Document $document, int $id): ?string
    {
        if (!array_key_exists($id, $this->infoTypes)) {
            $this->infoTypes[$id] = DB::connection($document->getConnectionName())
                ->table('info')->where('id', $id)->value('type');
        }

        return $this->infoTypes[$id];
    }

    /** @var array<int, ?BalanceItem> */
    private array $accounts = [];

    /** @var array<int, ?string> */
    private array $infoTypes = [];

    /** Общая часть операции: пустые стороны заполняются нулями и null */
    private function operation(Document $document, array $values, string $content, ?string $note): array
    {
        return $values + [
            'date'       => $document->date,
            'project_id' => $document->project_id,
            'quantity'   => 0,

            'in_info_1_id' => null, 'in_info_2_id' => null, 'in_info_3_id' => null, 'in_quantity' => 0,
            'out_info_1_id' => null, 'out_info_2_id' => null, 'out_info_3_id' => null, 'out_quantity' => 0,

            'source'     => 'document',
            'table_name' => 'documents',
            'table_id'   => (string) $document->id,
            'content'    => $content,
            'note'       => $note,
        ];
    }

    public function buildContent(Document $document): string
    {
        $document->loadMissing('info1');
        $parts = ['Реализация'];
        if ($document->info1) {
            $parts[] = $document->info1->name;
        }
        if ($document->number) {
            $parts[] = '№' . $document->number;
        }
        if ($document->date) {
            $parts[] = 'от ' . $document->date->format('d.m.Y');
        }
        return implode(' ', $parts);
    }
}
