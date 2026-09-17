<?php

namespace App\Services\Documents;

use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentItem;
use App\Services\Documents\CostCalculatorService;

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
 *   Кт  doc.revenue_bi_id (П587)
 *       info_1 = doc.revenue_item_id  (статья дохода,  П587.info_1_type = revenue)
 *       info_2 = item.info_1_id       (номенклатура,   П587.info_2_type = product)
 *
 * Операция №2 — Себестоимость (на сумму item.amount_cost, если > 0):
 *   Дт  doc.cogs_bi_id (П588)
 *       info_1 = doc.revenue_item_id  (статья дохода,  П588.info_1_type = revenue)
 *       info_2 = item.info_1_id       (номенклатура,   П588.info_2_type = product)
 *   Кт  item.bi_id (А200/А240)
 *       info_1 = item.info_1_id  (номенклатура)
 *       info_2 = item.info_2_id  (склад, если А200)
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
            $operations[] = $this->operation($document, [
                'amount'   => (float) $item->amount,
                'quantity' => $qty,

                'in_bi_id'     => $document->bi_id,
                'in_info_1_id' => $document->info_1_id,
                'in_quantity'  => $qty,

                'out_bi_id'     => $document->revenue_bi_id,
                'out_info_1_id' => $document->revenue_item_id,
                'out_info_2_id' => $item->info_1_id,
            ], $content, $item->note);
        }

        if ($document->cogs_bi_id && $item->amount_cost && $item->amount_cost > 0) {
            $operations[] = $this->operation($document, [
                'amount'   => (float) $item->amount_cost,
                'quantity' => $qty,

                'in_bi_id'     => $document->cogs_bi_id,
                'in_info_1_id' => $document->revenue_item_id,
                'in_info_2_id' => $item->info_1_id,
                'in_quantity'  => $qty,

                'out_bi_id'     => $item->bi_id,
                'out_info_1_id' => $item->info_1_id,
                'out_info_2_id' => $item->info_2_id,
                'out_info_3_id' => $item->info_3_id,
                'out_quantity'  => $qty,
            ], 'Себестоимость: ' . $content, $item->note);
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

        return [$this->operation($document, [
            'amount' => (float) $item->amount,

            'in_bi_id'     => $item->bi_id,
            'in_info_1_id' => $item->info_1_id,
            'in_info_2_id' => $item->info_2_id,

            'out_bi_id'     => $item->head_bi_id,
            'out_info_1_id' => $item->head_info_1_id,
            'out_info_2_id' => $item->head_info_2_id,
        ], $content, $item->note)];
    }

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
