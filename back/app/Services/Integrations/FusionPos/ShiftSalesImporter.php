<?php

namespace App\Services\Integrations\FusionPos;

use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentItem;
use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationLink;
use App\Models\Tenant\IntegrationRun;
use App\Services\Documents\DocumentService;
use App\Services\History\History;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Продажи FUSIONPOS → расходные накладные FINDIR.
 *
 * В кассе продажа лежит четырьмя уровнями: смена → заказы → чеки → строки
 * чеков. В управленческий учёт весь этот низ не нужен: финдиректору важны
 * выручка за смену, себестоимость проданного и то, чем за смену расплатились,
 * а не кто заказал капучино в 14:32. Поэтому **одна смена становится одной
 * расходной накладной**.
 *
 * Строк в ней несколько, и они разного вида (см. DocumentItem::KINDS):
 *
 *   продажа  — выручка и себестоимость, одной строкой на служебную позицию;
 *   оплата   — по строке на каждый тип оплаты смены: сколько закрыли наличными
 *              в кассу, сколько картой через банк-эквайер;
 *   налог    — если в чеках есть НДС.
 *
 * Откуда берутся суммы:
 *   выручка       — `total_amount` чека: столько заплатил гость, со скидками;
 *   себестоимость — `cost_price` строк чека, за единицу, значит × количество;
 *   оплаты        — `receipt-payments`, разбивка чека по типам оплат.
 *
 * Возвраты (`type = return`) вычитаются отовсюду: в кассе они лежат
 * отдельными чеками с положительными числами.
 *
 * Настройки — таблицами, а не полями: у каждой точки своя статья дохода и свой
 * склад, а у пары «точка × тип оплаты» свой счёт, своя касса или эквайер и своя
 * статья ДДС. Точка без настроек не грузится.
 */
final class ShiftSalesImporter
{
    public const ENTITY = 'pos_shift';

    /** Счёт шапки расходной накладной — «Клиенты». */
    private const HEADER_CODE = 'А300';

    private const MAX_DETAILS = 50;

    /** Предел списка для просмотра: смен за период много не бывает. */
    private const MAX_PREVIEW = 400;

    private string  $conn;
    private array   $details    = [];
    private ?array  $pointNames = null;
    private ?array  $typeNames  = null;
    private ?array  $accounts   = null;
    private bool    $lockLoaded = false;
    private ?string $lockValue  = null;

    /** uuid смены → сводка по чекам: считается один раз за запрос */
    private array $totals = [];

    public function __construct(
        private FusionPosClient $client,
        private Integration $integration,
    ) {
        $this->conn = $integration->getConnectionName();
    }

    // ─── Отбор смен ──────────────────────────────────────────────────

    /**
     * Условия отбора смен — общие для просмотра и загрузки.
     *
     * По дате отбираем только `created_at`: `closed_at_start` FUSIONPOS
     * принимает, но не применяет — проверено, возвращает всё подряд. Дата
     * открытия для смены и правильнее: смена, открытая 31-го вечером и
     * закрытая 1-го утром, в заведении зовётся сменой за 31-е.
     */
    private function buildQuery(array $cfg, string $from, string $to): array
    {
        $query = [
            'created_at_start' => $from . ' 00:00:00',
            'created_at_end'   => $to   . ' 23:59:59',
            'sort'             => 'id',
        ];

        // Тот же случай, что со складами в приходных накладных: список через
        // запятую FUSIONPOS читает как первое число. Одну точку отдаём
        // серверу, остальные отбираются сами — у них нет настроек
        if (count($cfg['points']) === 1) {
            $query['point_id'] = array_key_first($cfg['points']);
        }

        return $query;
    }

    /** Настройки точки этой смены; null — точка не настроена */
    private function pointCfg(array $shift, array $cfg): ?array
    {
        return $cfg['points'][(string) ($shift['point_id'] ?? '')] ?? null;
    }

    // ─── Просмотр ────────────────────────────────────────────────────

    public function preview(string $from, string $to): array
    {
        $cfg  = $this->config();
        $rows = [];

        $this->client->each('shifts', $this->buildQuery($cfg, $from, $to), function (array $items) use (&$rows, $cfg) {
            foreach ($items as $shift) {
                if (count($rows) >= self::MAX_PREVIEW) return;

                $rows[] = $this->describe($shift, $cfg);
            }
        });

        return $rows;
    }

    /** Строка списка: что за смена, сколько наторговала и в каком она состоянии. */
    private function describe(array $shift, array $cfg): array
    {
        $externalId = $this->externalId($shift);
        $date       = $this->resolveDate($shift, $cfg['shift_date_field']);
        $sum        = $this->totals($externalId);

        $link = $externalId === '' ? null : IntegrationLink::on($this->conn)
            ->where('integration_id', $this->integration->id)
            ->where('entity', self::ENTITY)
            ->where('external_id', $externalId)
            ->first();

        $existing = $link ? Document::on($this->conn)->find($link->local_id) : null;

        $status = match (true) {
            !$existing                                                => 'new',
            $link->fingerprint === $this->fingerprint($shift, $cfg)   => 'loaded',
            default                                                   => 'changed',
        };

        // Порядок проверок — от того, что человек изменить не может, к тому,
        // что он поправит сам. Уже загруженную смену не переоцениваем: она в
        // учёте, и говорить про неё «пока не закрыта» поздно
        if ($status !== 'loaded') {
            if (!$this->pointCfg($shift, $cfg)) {
                $status = 'unmapped';
            } elseif ($cfg['only_closed'] && empty($shift['closed_at'])) {
                $status = 'open';
            } elseif ($sum['receipts'] === 0 && $sum['returns'] === 0) {
                $status = 'empty';
            } elseif (($lock = $this->lockDate()) && $date && $date->toDateString() <= $lock) {
                $status = 'locked';
            }
        }

        return [
            'id'          => $externalId,
            'number'      => $shift['number'] ?? null,
            'date'        => $date?->toDateString(),
            'warehouse'   => $this->pointName($shift['point_id'] ?? null),
            'count'       => $sum['receipts'] + $sum['returns'],
            'amount'      => $sum['revenue'],
            'amount2'     => $sum['cost'],
            'status'      => $status,
            'document_id' => $existing?->id,
        ];
    }

    /**
     * Одна смена целиком: реквизиты, чеки и то, как она легла в учёт.
     *
     * Здесь уже показываем разбивку по оплатам: именно она отвечает на вопрос
     * «почему в кассе столько, а выручка другая».
     */
    public function describeOne(string $externalId): array
    {
        $cfg   = $this->config();
        $body  = $this->client->get('shifts', ['uuid' => $externalId]);
        $shift = ($body['items'] ?? [])[0] ?? null;

        if (!$shift) {
            throw new RuntimeException('Смена не найдена в источнике');
        }

        $row  = $this->describe($shift, $cfg);
        $sum  = $this->totals($externalId);
        $date = $this->resolveDate($shift, $cfg['shift_date_field']);

        $items = [];
        foreach ($sum['payments'] as $typeId => $amount) {
            $items[] = [
                'name'     => $this->typeName($typeId),
                'quantity' => '',
                'price'    => '',
                'amount'   => $amount,
            ];
        }

        return [
            'title' => 'В смене',
            'facts' => array_values(array_filter([
                ['label' => 'Точка',    'value' => $row['warehouse'] ?: '—'],
                ['label' => 'Открыта',  'value' => $this->moment($shift['created_at'] ?? null)],
                ['label' => 'Закрыта',  'value' => $this->moment($shift['closed_at'] ?? null) ?: 'ещё открыта'],
                ['label' => 'Чеков',    'value' => (string) $sum['receipts']],
                $sum['returns'] > 0 ? ['label' => 'Возвратов', 'value' => (string) $sum['returns']] : null,
                $sum['unpaid']  > 0 ? ['label' => 'Не оплачено', 'value' => $sum['unpaid'] . ' — в выручку не берём'] : null,
                ['label' => 'Выручка',       'value' => $this->money($sum['revenue']) . ' ₽'],
                ['label' => 'Себестоимость', 'value' => $this->money($sum['cost']) . ' ₽'],
                $sum['vat'] > 0 ? ['label' => 'Налог в чеках', 'value' => $this->money($sum['vat']) . ' ₽'] : null,
            ])),
            'columns' => ['name' => 'Чем оплачено', 'quantity' => '', 'price' => '', 'amount' => 'Сумма'],
            'items'   => $items,
            'amount'  => array_sum($sum['payments']),
            'status'      => $row['status'],
            'document_id' => $row['document_id'],
            'posting'     => $this->postingSummary($cfg, $shift, $sum, $date),
            'note'        => 'Чеки в проводки не переносятся: вся смена идёт одной строкой '
                           . 'на служебную позицию, а оплаты — отдельными строками, каждая '
                           . 'закрывает долг покупателя своим счётом.',
        ];
    }

    /** Куда ляжет смена в нашем учёте — человеческими названиями. */
    private function postingSummary(array $cfg, array $shift, array $sum, ?Carbon $date): array
    {
        $point = $this->pointCfg($shift, $cfg);

        if (!$point) {
            return ['rows' => [[
                'label' => 'Точка не настроена',
                'value' => 'Заполните строку точки «' . $this->pointName($shift['point_id'] ?? null)
                         . '» в настройках интеграции',
            ]]];
        }

        $name = fn(string $table, $id) => $id
            ? DB::connection($this->conn)->table($table)->where('id', $id)->value('name')
            : null;

        $account = function ($id) use ($name) {
            $a = $this->accounts()[$id] ?? null;
            return $a ? trim($a->code . ' ' . $a->name) : '—';
        };

        $rows = [
            ['label' => 'Проект',       'value' => $name('projects', $cfg['project_id']) ?: '—'],
            ['label' => 'Дата',         'value' => $date?->format('d.m.Y') ?: '—'],
            ['label' => 'Покупатель',   'value' => $name('info', $cfg['customer_id']) ?: '—'],
            ['label' => 'Статья дохода', 'value' => $name('info', $point['revenue_item_id']) ?: '—'],
            ['label' => 'Выручка',      'value' => $account($cfg['header_bi_id']) . ' ← ' . $account($cfg['revenue_bi_id'])
                                                 . '   ' . $this->money($sum['revenue']) . ' ₽'],
            ['label' => 'Себестоимость', 'value' => $account($cfg['cogs_bi_id']) . ' ← ' . $account($point['line_bi_id'])
                                                 . '   ' . $this->money($sum['cost']) . ' ₽'],
        ];

        foreach ($sum['payments'] as $typeId => $amount) {
            $pay = $this->paymentCfg($cfg, $shift, $typeId);

            $rows[] = [
                'label' => $this->typeName($typeId),
                'value' => $pay
                    ? $account($pay['bi_id']) . ' ← ' . $account($cfg['header_bi_id'])
                      . '   ' . $this->money($amount) . ' ₽'
                    : 'не настроено — ' . $this->money($amount) . ' ₽ повиснут на покупателе',
            ];
        }

        if ($sum['vat'] > 0) {
            $rows[] = [
                'label' => 'Налог',
                'value' => $cfg['vat']
                    ? $account($cfg['vat']['bi_id']) . ' ← ' . $account($cfg['vat']['head_bi_id'])
                      . '   ' . $this->money($sum['vat']) . ' ₽'
                    : 'в чеках есть налог, но счета налога не заполнены',
            ];
        }

        return ['rows' => $rows];
    }

    // ─── Загрузка ────────────────────────────────────────────────────

    public function run(IntegrationRun $run, string $from, string $to, ?array $only = null): void
    {
        $cfg  = $this->config();
        $pick = $only === null ? null : array_flip($only);

        // Отмеченное грузим, даже если оно не менялось: раз человек выбрал
        // строку руками, «пропущено» — не тот ответ, которого он ждёт
        $force = $pick !== null;

        $this->client->each('shifts', $this->buildQuery($cfg, $from, $to), function (array $items) use ($run, $cfg, $pick, $force) {
            foreach ($items as $shift) {
                if ($pick !== null && !isset($pick[$this->externalId($shift)])) continue;

                $run->fetched++;
                try {
                    $this->importOne($shift, $run, $cfg, $force);
                } catch (\Throwable $e) {
                    $run->failed++;
                    $this->warn($this->label($shift) . ' — ' . $e->getMessage());
                }
            }
        });

        $run->details = $this->details ?: null;
    }

    private function importOne(array $shift, IntegrationRun $run, array $cfg, bool $force): void
    {
        $externalId = $this->externalId($shift);
        if ($externalId === '') {
            throw new RuntimeException('в ответе нет ни uuid, ни id смены');
        }

        $point = $this->pointCfg($shift, $cfg);
        if (!$point) {
            $run->skipped++;
            $this->warn($this->label($shift) . ' — точка «' . $this->pointName($shift['point_id'] ?? null)
                . '» не настроена, смена пропущена');
            return;
        }

        $date = $this->resolveDate($shift, $cfg['shift_date_field']);
        if (!$date) {
            throw new RuntimeException('у смены нет ни даты открытия, ни даты закрытия');
        }

        // Незакрытую смену не берём: чеки в неё ещё придут, и документ пришлось
        // бы перепроводить после каждой продажи
        if ($cfg['only_closed'] && empty($shift['closed_at'])) {
            $run->skipped++;
            $this->warn($this->label($shift) . ' — ещё не закрыта, продажи возьмём после закрытия');
            return;
        }

        $sum = $this->totals($externalId);

        if ($sum['receipts'] === 0 && $sum['returns'] === 0) {
            $run->skipped++;
            return;
        }

        $link = IntegrationLink::on($this->conn)
            ->where('integration_id', $this->integration->id)
            ->where('entity', self::ENTITY)
            ->where('external_id', $externalId)
            ->first();

        $fingerprint = $this->fingerprint($shift, $cfg);
        $existing    = $link ? Document::on($this->conn)->find($link->local_id) : null;

        if (!$force && $existing && $link->fingerprint === $fingerprint) {
            $run->skipped++;
            return;
        }

        if ($lock = $this->lockDate()) {
            if ($date->toDateString() <= $lock) {
                $run->failed++;
                $this->warn($this->label($shift) . " — период закрыт по {$lock}, смена пропущена");
                return;
            }
        }

        $lines = $this->lines($shift, $cfg, $point, $sum);

        DB::connection($this->conn)->transaction(function () use (
            $shift, $cfg, $date, $sum, $lines, $externalId, $link, $existing, $run
        ) {
            // Снимок до правки: документ составной, и «что изменилось» узнаётся
            // только сравнением снимков. Снимаем до заполнения — потом поздно
            $before = $existing ? $existing->historySnapshot() : [];

            $doc = $existing ?: (new Document)->setConnection($this->conn);

            $doc->fill([
                'date'            => $date,
                'number'          => $shift['number'] ?? null,
                'external_number' => $shift['number'] ?? null,
                'project_id'      => $cfg['project_id'],
                'type'            => 'outgoing_invoice',
                'bi_id'           => $cfg['header_bi_id'],
                'info_1_id'       => $cfg['customer_id'],
                'revenue_bi_id'   => $cfg['revenue_bi_id'],
                'cogs_bi_id'      => $cfg['cogs_bi_id'],
                'revenue_item_id' => $this->pointCfg($shift, $cfg)['revenue_item_id'],
                'amount'          => $sum['revenue'],
                'note'            => $this->buildNote($shift, $sum),
                'extra'           => [
                    'source'         => 'fusionpos',
                    'integration_id' => $this->integration->id,
                    'uuid'           => $externalId,
                    'shift_number'   => $shift['number'] ?? null,
                    'point_id'       => $shift['point_id'] ?? null,
                    'receipts'       => $sum['receipts'],
                    'returns'        => $sum['returns'],
                    'cost'           => $sum['cost'],
                    'payments'       => $sum['payments'],
                ],
            ]);
            if (!$doc->exists) $doc->status = 'draft';
            $doc->save();

            DocumentItem::on($this->conn)->where('document_id', $doc->id)->delete();

            foreach ($lines as $i => $line) {
                $item = (new DocumentItem)->setConnection($this->conn);
                $item->fill(['document_id' => $doc->id, 'sort_order' => $i] + $line);
                $item->save();
            }

            if ($cfg['post_documents']) {
                DocumentService::post($doc);
            } else {
                $doc->content = DocumentService::strategyFor($doc)->buildContent($doc);
                $doc->save();
            }

            $this->saveLink($link, $externalId, $doc->id, $this->fingerprint($shift, $cfg));

            // Загруженный документ виден в журнале изменений наравне с
            // заведённым руками: иначе смена появлялась бы в учёте без следа
            app(History::class)->recordFrom($doc->refresh(), $before, $existing ? 'updated' : 'created');

            $existing ? $run->updated++ : $run->created++;
        });
    }

    /**
     * Строки документа: продажа, оплаты, налог.
     *
     * Сумма оплат должна сойтись с выручкой — иначе долг покупателя не
     * закроется и повиснет в остатках. Если не сошлась, говорим об этом вслух:
     * молча оставить перекос хуже, чем не загрузить.
     */
    private function lines(array $shift, array $cfg, array $point, array $sum): array
    {
        $content = $this->buildContent($shift);

        $lines = [[
            'kind'      => DocumentItem::KIND_SALE,
            'bi_id'     => $point['line_bi_id'],
            'info_1_id' => $point['product_id'],
            // Количество — рубли себестоимости, цена 1. Со складского счёта
            // уходит ровно столько же единиц, сколько на него пришло с
            // приходной накладной, и количество там остаётся равно рублям.
            // Сумма строки при этом — выручка: расходная накладная продаёт
            // на неё, а не на себестоимость
            'quantity'    => $sum['cost'],
            'price'       => 1,
            'amount'      => $sum['revenue'],
            'amount_cost' => $sum['cost'],
            'content'     => $content,
        ]];

        $paid = 0.0;

        foreach ($sum['payments'] as $typeId => $amount) {
            if (!$amount) continue;

            $pay = $this->paymentCfg($cfg, $shift, $typeId);

            if (!$pay) {
                $this->warn($this->label($shift) . ' — оплата «' . $this->typeName($typeId)
                    . '» не настроена, ' . $this->money($amount) . ' ₽ остались на покупателе');
                continue;
            }

            $lines[] = [
                'kind'      => DocumentItem::KIND_PAYMENT,
                'bi_id'     => $pay['bi_id'],
                'info_1_id' => $pay['info_1_id'] ?: null,
                'info_2_id' => $pay['flow_slot'] ? ($pay['flow_id'] ?: null) : null,
                'amount'    => $amount,
                'content'   => $content . ', ' . $this->typeName($typeId),
            ];

            $paid += $amount;
        }

        if (abs($paid - $sum['revenue']) > 0.01 && $paid > 0) {
            $this->warn($this->label($shift) . ' — оплат на ' . $this->money($paid)
                . ' ₽ против выручки ' . $this->money($sum['revenue'])
                . ' ₽, разница останется долгом покупателя');
        }

        if ($sum['vat'] > 0) {
            if ($cfg['vat']) {
                $lines[] = [
                    'kind'           => DocumentItem::KIND_VAT,
                    'bi_id'          => $cfg['vat']['bi_id'],
                    'info_1_id'      => $cfg['vat']['item_id'] ?: null,
                    'head_bi_id'     => $cfg['vat']['head_bi_id'],
                    'head_info_1_id' => $cfg['vat']['partner_id'] ?: null,
                    'amount'         => $sum['vat'],
                    'content'        => 'Налог: ' . $content,
                ];
            } else {
                $this->warn($this->label($shift) . ' — в чеках есть налог на '
                    . $this->money($sum['vat']) . ' ₽, но счета налога в настройках не заполнены');
            }
        }

        return $lines;
    }

    // ─── Чеки смены ──────────────────────────────────────────────────

    /**
     * Выручка, себестоимость, налог и оплаты смены.
     *
     * Неоплаченный чек в выручку не берём: гость ушёл, не заплатив, или чек
     * бросили открытым — денег по нему нет. Считаем такие отдельно, чтобы в
     * карточке смены было видно, почему сумма меньше ожидаемой.
     *
     * Себестоимость берём из строк чека: там она лежит **за единицу**, поэтому
     * умножаем на количество. В самом чеке сумма тех же строк и лежит —
     * проверено на всей выгрузке, — но строку считаем первоисточником.
     *
     * @return array{receipts:int, returns:int, unpaid:int, revenue:float, cost:float, vat:float, payments:array}
     */
    private function totals(string $shiftUuid): array
    {
        if (isset($this->totals[$shiftUuid])) return $this->totals[$shiftUuid];

        $receipts = $returns = $unpaid = 0;
        $revenue  = $cost = $vat = 0.0;
        $payments = [];

        $query = ['shift_uuid' => $shiftUuid, 'sort' => 'id', 'expand' => 'receiptItems,receiptPayments'];

        $this->client->each('receipts', $query,
            function (array $items) use (&$receipts, &$returns, &$unpaid, &$revenue, &$cost, &$vat, &$payments) {
                foreach ($items as $r) {
                    if (!empty($r['deleted_at'])) continue;

                    if (empty($r['is_paid'])) { $unpaid++; continue; }

                    $return = ($r['type'] ?? 'full') === 'return';
                    $sign   = $return ? -1 : 1;

                    $return ? $returns++ : $receipts++;

                    $revenue += $sign * (float) ($r['total_amount'] ?? 0);

                    foreach ($r['receiptItems'] ?? [] as $line) {
                        if (!empty($line['deleted_at'])) continue;

                        $cost += $sign * (float) ($line['cost_price'] ?? 0) * (float) ($line['quantity'] ?? 0);

                        // Налога в чеках сегодня нет — касса на УСН отдаёт
                        // пустое поле. Читаем на будущее и только числа
                        if (is_numeric($line['vat'] ?? null)) {
                            $vat += $sign * (float) $line['vat'];
                        }
                    }

                    foreach ($r['receiptPayments'] ?? [] as $pay) {
                        if (!empty($pay['deleted_at'])) continue;

                        $type = (string) ($pay['payment_type_id'] ?? '');
                        $payments[$type] = ($payments[$type] ?? 0) + $sign * (float) ($pay['amount'] ?? 0);
                    }
                }
            });

        return $this->totals[$shiftUuid] = [
            'receipts' => $receipts,
            'returns'  => $returns,
            'unpaid'   => $unpaid,
            'revenue'  => round($revenue / 100, 2),
            'cost'     => round($cost / 100, 2),
            'vat'      => round($vat / 100, 2),
            'payments' => array_map(fn($v) => round($v / 100, 2), $payments),
        ];
    }

    // ─── Настройки ───────────────────────────────────────────────────

    /**
     * Проверяем настройки заранее: на середине загрузки падать некрасиво.
     *
     * Общие поля — покупатель и счета реализации — одни на интеграцию. Всё,
     * что различается по точкам, лежит таблицами: точка без строки не грузится,
     * и отдельного фильтра «какие точки брать» не нужно.
     */
    private function config(): array
    {
        $i = $this->integration;

        $headerBiId = DB::connection($this->conn)->table('balance_items')
            ->where('code', self::HEADER_CODE)->value('id');

        if (!$headerBiId) {
            throw new RuntimeException('В плане счетов нет счёта ' . self::HEADER_CODE . ' «Клиенты»');
        }

        $required = [
            'project_id'          => 'проект',
            'sales_customer_id'   => 'покупатель',
            'sales_revenue_bi_id' => 'счёт доходов',
            'sales_cogs_bi_id'    => 'счёт себестоимости',
        ];

        $missing = [];
        foreach ($required as $key => $label) {
            if (!$i->setting($key)) $missing[] = $label;
        }

        if ($missing) {
            throw new RuntimeException('В настройках интеграции не заполнено для продаж: ' . implode(', ', $missing));
        }

        $points = [];
        foreach ((array) $i->setting('point_map', []) as $pointId => $row) {
            $row = (array) $row;

            // Строка считается заполненной, только когда в ней есть всё:
            // половина настройки — это документ без себестоимости или без
            // разреза выручки, и заметят это не сразу
            if (empty($row['revenue_item_id']) || empty($row['line_bi_id']) || empty($row['product_id'])) continue;

            $points[(string) $pointId] = [
                'revenue_item_id' => (int) $row['revenue_item_id'],
                'line_bi_id'      => (int) $row['line_bi_id'],
                'product_id'      => (int) $row['product_id'],
            ];
        }

        if (!$points) {
            throw new RuntimeException(
                'В настройках интеграции не заполнена ни одна точка продаж: '
                . 'нужны статья дохода, счёт списания и номенклатура'
            );
        }

        $payments = [];
        foreach ((array) $i->setting('payment_map', []) as $key => $row) {
            $row = (array) $row;
            if (empty($row['bi_id'])) continue;

            $account = $this->accounts()[(int) $row['bi_id']] ?? null;

            $payments[(string) $key] = [
                'bi_id'     => (int) $row['bi_id'],
                'info_1_id' => (int) ($row['info_1_id'] ?? 0),
                'flow_id'   => (int) ($row['flow_id'] ?? 0),
                // Статья ДДС ложится во второй слот и только если счёт его
                // ведёт: у А300 второго слота нет, и класть туда нечего
                'flow_slot' => ($account->info_2_type ?? null) === 'flow',
            ];
        }

        $vat = $i->setting('vat_bi_id') && $i->setting('vat_head_bi_id')
            ? [
                'bi_id'      => (int) $i->setting('vat_bi_id'),
                'item_id'    => (int) $i->setting('vat_item_id'),
                'head_bi_id' => (int) $i->setting('vat_head_bi_id'),
                'partner_id' => (int) $i->setting('vat_partner_id'),
            ]
            : null;

        return [
            'header_bi_id'     => (int) $headerBiId,
            'project_id'       => (int) $i->setting('project_id'),
            'customer_id'      => (int) $i->setting('sales_customer_id'),
            'revenue_bi_id'    => (int) $i->setting('sales_revenue_bi_id'),
            'cogs_bi_id'       => (int) $i->setting('sales_cogs_bi_id'),
            'points'           => $points,
            'payments'         => $payments,
            'vat'              => $vat,
            'shift_date_field' => $i->setting('shift_date_field', 'created_at'),
            'only_closed'      => (bool) $i->setting('only_closed_shifts', true),
            'post_documents'   => (bool) $i->setting('post_documents', true),
        ];
    }

    /** Настройка оплаты для пары «точка × тип» */
    private function paymentCfg(array $cfg, array $shift, $typeId): ?array
    {
        return $cfg['payments'][($shift['point_id'] ?? '') . ':' . $typeId] ?? null;
    }

    /** План счетов по идентификатору: нужен и слотам, и подписям */
    private function accounts(): array
    {
        return $this->accounts ??= DB::connection($this->conn)->table('balance_items')
            ->get(['id', 'code', 'name', 'info_1_type', 'info_2_type'])
            ->keyBy('id')->all();
    }

    // ─── Вспомогательное ─────────────────────────────────────────────

    private function externalId(array $shift): string
    {
        return (string) ($shift['uuid'] ?? $shift['id'] ?? '');
    }

    private function resolveDate(array $shift, string $field): ?Carbon
    {
        $primary  = $field === 'closed_at' ? 'closed_at' : 'created_at';
        $fallback = $primary === 'closed_at' ? 'created_at' : 'closed_at';

        return $this->parse($shift[$primary] ?? null) ?? $this->parse($shift[$fallback] ?? null);
    }

    private function parse(?string $value): ?Carbon
    {
        if (!$value) return null;
        try { return Carbon::parse($value); } catch (\Throwable) { return null; }
    }

    private function moment(?string $value): string
    {
        return $this->parse($value)?->format('d.m.Y H:i') ?? '';
    }

    private function money(float $value): string
    {
        return number_format($value, 2, ',', ' ');
    }

    /**
     * Отпечаток значимых полей.
     *
     * Суммы и разбивка по оплатам входят обязательно: смену закрыли, потом
     * провели по ней возврат — реквизиты смены не изменились, а документ
     * должен перестроиться.
     */
    private function fingerprint(array $shift, array $cfg): string
    {
        $sum   = $this->totals($this->externalId($shift));
        $point = $this->pointCfg($shift, $cfg) ?? [];

        ksort($sum['payments']);

        return sha1(json_encode([
            $shift['number']     ?? null,
            $shift['point_id']   ?? null,
            $shift['created_at'] ?? null,
            $shift['closed_at']  ?? null,
            $sum['receipts'], $sum['returns'], $sum['revenue'], $sum['cost'], $sum['vat'],
            $sum['payments'],
            // Настройки тоже входят: сменили счёт или позицию — документы
            // должны перестроиться, а не остаться на старых
            $point, $cfg['payments'], $cfg['vat'],
            $cfg['customer_id'], $cfg['revenue_bi_id'], $cfg['cogs_bi_id'],
            $cfg['project_id'], $cfg['shift_date_field'], $cfg['post_documents'],
        ], JSON_UNESCAPED_UNICODE));
    }

    private function saveLink(?IntegrationLink $link, string $externalId, int $documentId, string $fingerprint): void
    {
        $link ??= (new IntegrationLink)->setConnection($this->conn);
        $link->fill([
            'integration_id' => $this->integration->id,
            'entity'         => self::ENTITY,
            'external_id'    => $externalId,
            'local_type'     => 'document',
            'local_id'       => $documentId,
            'fingerprint'    => $fingerprint,
            'synced_at'      => now(),
        ]);
        $link->save();
    }

    /** Названия точек читаем один раз: их единицы, а смен за период десятки. */
    private function pointName($id): ?string
    {
        if ($id === null) return null;

        $this->pointNames ??= $this->remoteNames('points');

        return $this->pointNames[(string) $id] ?? ('точка #' . $id);
    }

    private function typeName($id): string
    {
        $this->typeNames ??= $this->remoteNames('payment-types');

        return $this->typeNames[(string) $id] ?? ('оплата #' . $id);
    }

    /** @return array<string, string> id → название из справочника кассы */
    private function remoteNames(string $path): array
    {
        $out = [];

        try {
            $this->client->each($path, [], function (array $items) use (&$out) {
                foreach ($items as $row) {
                    if (isset($row['id'])) $out[(string) $row['id']] = $row['name'] ?? null;
                }
            });
        } catch (\Throwable) {
            // Без названий смена всё равно читается — суммы на месте
        }

        return $out;
    }

    private function buildContent(array $shift): string
    {
        $parts = ['Продажи FUSIONPOS'];
        if ($p = $this->pointName($shift['point_id'] ?? null)) $parts[] = $p;
        if ($n = ($shift['number'] ?? null))                   $parts[] = "смена №{$n}";

        return implode(', ', $parts);
    }

    private function buildNote(array $shift, array $sum): string
    {
        $parts = [];
        if ($p = $this->pointName($shift['point_id'] ?? null)) $parts[] = $p;

        $parts[] = 'чеков: ' . $sum['receipts'];
        if ($sum['returns'] > 0) $parts[] = 'возвратов: ' . $sum['returns'];
        if ($sum['unpaid'] > 0)  $parts[] = 'не оплачено: ' . $sum['unpaid'];

        $parts[] = 'себестоимость: ' . $this->money($sum['cost']);

        foreach ($sum['payments'] as $typeId => $amount) {
            $parts[] = $this->typeName($typeId) . ': ' . $this->money($amount);
        }

        if ($c = $this->moment($shift['closed_at'] ?? null)) $parts[] = 'закрыта ' . $c;

        $parts[] = 'FUSIONPOS ' . $this->externalId($shift);

        return implode(', ', $parts);
    }

    private function label(array $shift): string
    {
        $n = $shift['number'] ?? ('id ' . ($shift['id'] ?? '?'));
        $d = $this->parse($shift['created_at'] ?? null);

        return 'Смена №' . $n . ($d ? ' от ' . $d->format('d.m.Y') : '');
    }

    /**
     * Дата запрета читается один раз за загрузку. Кэш в объекте, а не в static:
     * воркер очереди живёт долго и обслуживает разные компании подряд.
     */
    private function lockDate(): ?string
    {
        if ($this->lockLoaded) return $this->lockValue;

        $this->lockValue  = DB::connection($this->conn)->table('settings')
            ->where('key', 'edit_lock_date')->value('value') ?: null;
        $this->lockLoaded = true;

        return $this->lockValue;
    }

    private function warn(string $message): void
    {
        if (count($this->details) < self::MAX_DETAILS) {
            $this->details[] = $message;
        }
    }
}
