<?php

namespace App\Services\Integrations\FusionPos;

use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentItem;
use App\Models\Tenant\Info;
use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationLink;
use App\Models\Tenant\IntegrationRun;
use App\Services\Documents\DocumentService;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Приходные накладные FUSIONPOS → документы FINDIR.
 *
 * Правило переноса задано учётной политикой, а не системой-источником:
 * вся накладная ложится одной строкой на служебную номенклатуру по цене
 * 1 ₽, поэтому количество на складском счёте равно рублям. Номенклатуры в
 * FINDIR при этом нет — зато суммы поставок сходятся с обороткой.
 */
final class WarehouseInvoiceImporter
{
    public const ENTITY = 'warehouse_invoice';

    /** Счёт шапки приходной накладной — «Поставщики». */
    private const HEADER_CODE = 'П100';

    /** Сколько предупреждений сохраняем в журнале: остальное — шум. */
    private const MAX_DETAILS = 50;

    /** Предел списка для просмотра: дальше таблицу всё равно не осмотреть. */
    private const MAX_PREVIEW = 1000;

    /** Сколько страниц справочника номенклатуры вычитываем ради названий. */
    private const MAX_DICT_PAGES = 20;

    private string  $conn;
    private array   $details      = [];
    private array   $supplierById = [];  // кэш: id поставщика FUSIONPOS → id в справочнике
    private bool    $lockLoaded   = false;
    private ?string $lockValue    = null;
    private ?array  $nomenclature = null;  // id → название, читается один раз

    public function __construct(
        private FusionPosClient $client,
        private Integration $integration,
    ) {
        $this->conn = $integration->getConnectionName();
    }

    /** Условия отбора накладных — общие для просмотра и для загрузки. */
    private function buildQuery(array $cfg, string $from, string $to): array
    {
        $query = [
            'expand'         => 'supplier,warehouse,legalEntity',
            'doc_date_start' => $from . ' 00:00:00',
            'doc_date_end'   => $to   . ' 23:59:59',
            'sort'           => 'id',
        ];

        // Дата документа поставщика заполнена не всегда; когда сверяемся по
        // дате проведения — и фильтровать надо по ней, иначе накладные без
        // doc_date не попадут в выборку вообще
        if ($cfg['date_field'] === 'processed_at') {
            unset($query['doc_date_start'], $query['doc_date_end']);
            $query['processed_at_start'] = $from . ' 00:00:00';
            $query['processed_at_end']   = $to   . ' 23:59:59';
        }

        if ($cfg['only_processed'])   $query['is_processed']    = 'true';
        if ($cfg['warehouse_ids'])    $query['warehouse_id']    = implode(',', $cfg['warehouse_ids']);
        if ($cfg['legal_entity_ids']) $query['legal_entity_id'] = implode(',', $cfg['legal_entity_ids']);

        return $query;
    }

    /**
     * Что лежит в источнике за период — без единой записи в базу.
     *
     * Первый шаг двухшаговой загрузки: человек видит список и отмечает, что
     * именно брать. Уже загруженное показываем тоже — иначе непонятно, всё ли
     * на месте, и приходится грузить наугад.
     */
    public function preview(string $from, string $to): array
    {
        $cfg   = $this->config();
        $query = $this->buildQuery($cfg, $from, $to);
        $rows  = [];

        $this->client->each('warehouse/invoices', $query, function (array $items) use (&$rows, $cfg) {
            foreach ($items as $invoice) {
                if (count($rows) >= self::MAX_PREVIEW) return;
                $rows[] = $this->describe($invoice, $cfg);
            }
        });

        // Удалённые в источнике — отдельным проходом и с своей пометкой:
        // по ним загрузка означает снятие документа, а не создание
        $deleted = $query;
        $deleted['is_deleted'] = 'true';
        unset($deleted['is_processed']);

        $this->client->each('warehouse/invoices', $deleted, function (array $items) use (&$rows, $cfg) {
            foreach ($items as $invoice) {
                if (count($rows) >= self::MAX_PREVIEW) return;

                $row = $this->describe($invoice, $cfg);
                if ($row['status'] === 'new') continue;   // не грузили — и снимать нечего

                $row['status'] = 'deleted';
                $rows[] = $row;
            }
        });

        return $rows;
    }

    /**
     * Загрузка за период.
     *
     * $only — внешние идентификаторы отмеченных накладных; null означает «всё,
     * что попадает в период».
     */
    public function run(IntegrationRun $run, string $from, string $to, ?array $only = null): void
    {
        $cfg   = $this->config();
        $query = $this->buildQuery($cfg, $from, $to);
        $pick  = $only === null ? null : array_flip($only);

        // Отмеченное грузим, даже если оно не менялось: раз человек выбрал
        // строку руками, «пропущено, ничего не изменилось» — не тот ответ,
        // которого он ждёт. Без отметок работает прежняя бережная логика
        $force = $pick !== null;

        $this->client->each('warehouse/invoices', $query, function (array $items) use ($run, $cfg, $pick, $force) {
            foreach ($items as $invoice) {
                if ($pick !== null && !isset($pick[$this->externalId($invoice)])) continue;

                $run->fetched++;
                try {
                    $this->importOne($invoice, $run, $cfg, $force);
                } catch (\Throwable $e) {
                    $run->failed++;
                    $this->warn($this->label($invoice) . ' — ' . $e->getMessage());
                }
            }
        });

        $this->removeDeleted($query, $run, $pick);

        $run->details = $this->details ?: null;
    }

    /** Строка списка: что это за накладная и в каком она у нас состоянии. */
    private function describe(array $invoice, array $cfg): array
    {
        $externalId = $this->externalId($invoice);
        $date       = $this->resolveDate($invoice, $cfg['date_field']);

        $link = $externalId === '' ? null : IntegrationLink::on($this->conn)
            ->where('integration_id', $this->integration->id)
            ->where('entity', self::ENTITY)
            ->where('external_id', $externalId)
            ->first();

        $existing = $link ? Document::on($this->conn)->find($link->local_id) : null;

        $status = match (true) {
            !$existing                                                  => 'new',
            $link->fingerprint === $this->fingerprint($invoice, $cfg)   => 'loaded',
            default                                                     => 'changed',
        };

        // Закрытый период важнее остального: такую накладную не взять, и
        // отмечать её к загрузке бессмысленно
        $lock = $this->lockDate();
        if ($status !== 'loaded' && $date && $lock && $date->toDateString() <= $lock) {
            $status = 'locked';
        }

        return [
            'id'          => $externalId,
            'number'      => $invoice['doc_number'] ?? null,
            'date'        => $date?->toDateString(),
            'supplier'    => data_get($invoice, 'supplier.name'),
            'inn'         => data_get($invoice, 'supplier.inn'),
            'warehouse'   => data_get($invoice, 'warehouse.name'),
            'amount'      => round(((int) ($invoice['amount'] ?? 0)) / 100, 2),
            'status'      => $status,
            'document_id' => $existing?->id,
        ];
    }

    private function externalId(array $invoice): string
    {
        return (string) ($invoice['uuid'] ?? $invoice['id'] ?? '');
    }

    /**
     * Одна накладная целиком: реквизиты, состав и то, как она легла у нас.
     *
     * Состав в учёт не переносится — вся накладная ложится одной строкой на
     * служебную позицию. Но увидеть, что именно закупили, финдиректору нужно,
     * поэтому показываем позиции источника рядом с нашей единственной строкой.
     */
    public function describeOne(string $externalId): array
    {
        $cfg  = $this->config();
        $body = $this->client->get('warehouse/invoices', [
            'uuid'   => $externalId,
            'expand' => 'supplier,warehouse,legalEntity,warehouseInvoiceItems',
        ]);

        $invoice = ($body['items'] ?? [])[0] ?? null;
        if (!$invoice) {
            throw new RuntimeException('Накладная не найдена в источнике — возможно, её удалили');
        }

        $items = $invoice['warehouseInvoiceItems'] ?? [];
        $names = $this->nomenclatureNames(array_column($items, 'nomenclature_id'));

        $row = $this->describe($invoice, $cfg);

        return [
            'number'       => $invoice['doc_number'] ?? null,
            'date'         => $this->parse($invoice['doc_date'] ?? null)?->toDateString(),
            'processed_at' => $this->parse($invoice['processed_at'] ?? null)?->format('d.m.Y H:i'),
            'supplier'     => data_get($invoice, 'supplier.name'),
            'inn'          => data_get($invoice, 'supplier.inn'),
            'kpp'          => data_get($invoice, 'supplier.kpp'),
            'warehouse'    => data_get($invoice, 'warehouse.name'),
            'legal_entity' => data_get($invoice, 'legalEntity.name'),
            'comment'      => $invoice['comment'] ?? null,
            'amount'       => round(((int) ($invoice['amount'] ?? 0)) / 100, 2),
            'vat_amount'   => round(((int) ($invoice['vat_amount'] ?? 0)) / 100, 2),
            'status'       => $row['status'],
            'document_id'  => $row['document_id'],
            'items'        => array_map(fn($it) => [
                'name'     => $names[$it['nomenclature_id'] ?? null] ?? ('позиция #' . ($it['nomenclature_id'] ?? '?')),
                'quantity' => (float) ($it['quantity'] ?? 0),
                'price'    => round(((int) ($it['price'] ?? 0)) / 100, 2),
                'amount'   => round(((int) ($it['amount'] ?? 0)) / 100, 2),
            ], $items),
            // Как это легло в учёт — чтобы не гадать, что получилось из накладной
            'posting'      => $this->postingSummary($cfg, $invoice),
        ];
    }

    /**
     * Названия номенклатуры.
     *
     * Фильтр `id` в FUSIONPOS принимает одно число, списком его не передать —
     * поэтому читаем справочник страницами и складываем в карту. За каждой
     * позицией отдельным запросом ходить нельзя: в накладной их бывает под сотню.
     *
     * Справочник читается один раз на объект: показ состава ходит сюда за
     * каждой раскрытой накладной.
     */
    private function nomenclatureNames(array $ids): array
    {
        if ($this->nomenclature !== null) return $this->nomenclature;
        if (!array_filter($ids))          return $this->nomenclature = [];

        $this->nomenclature = [];
        $page = 1;

        try {
            do {
                $body = $this->client->get('nomenclatures', ['page' => $page, 'per-page' => 100]);

                foreach ($body['items'] ?? [] as $n) {
                    if (isset($n['id'])) $this->nomenclature[$n['id']] = $n['name'] ?? null;
                }

                $pages = (int) data_get($body, '_meta.pageCount', 1);
                $page++;
            } while ($page <= $pages && $page <= self::MAX_DICT_PAGES);
        } catch (\Throwable) {
            // Без названий состав всё равно читается — суммы и количества на месте
        }

        return $this->nomenclature;
    }

    /** Куда ляжет накладная в нашем учёте — человеческими названиями. */
    private function postingSummary(array $cfg, array $invoice): array
    {
        $name = fn(string $table, $id) => $id
            ? DB::connection($this->conn)->table($table)->where('id', $id)->value('name')
            : null;

        $rubles = round(((int) ($invoice['amount'] ?? 0)) / 100, 2);

        return [
            'project'  => $name('projects', $cfg['project_id']),
            'debit'    => DB::connection($this->conn)->table('balance_items')
                            ->where('id', $cfg['line_bi_id'])->value('code') . ' '
                          . $name('balance_items', $cfg['line_bi_id']),
            'credit'   => self::HEADER_CODE . ' ' . $name('balance_items', $cfg['header_bi_id']),
            'product'  => $name('info', $cfg['service_product_id']),
            'quantity' => $rubles,
            'price'    => 1,
            'amount'   => $rubles,
        ];
    }

    // ─── Одна накладная ──────────────────────────────────────────────

    private function importOne(array $invoice, IntegrationRun $run, array $cfg, bool $force = false): void
    {
        $externalId = $this->externalId($invoice);
        if ($externalId === '') {
            throw new RuntimeException('в ответе нет ни uuid, ни id');
        }

        $date = $this->resolveDate($invoice, $cfg['date_field']);
        if (!$date) {
            throw new RuntimeException('не заполнена ни дата документа, ни дата проведения');
        }

        $link = IntegrationLink::on($this->conn)
            ->where('integration_id', $this->integration->id)
            ->where('entity', self::ENTITY)
            ->where('external_id', $externalId)
            ->first();

        $fingerprint = $this->fingerprint($invoice, $cfg);

        $existing = $link
            ? Document::on($this->conn)->find($link->local_id)
            : null;

        // Ничего не изменилось — не трогаем: иначе каждая загрузка
        // перепроводила бы весь период и переписывала ручные правки.
        // Явно отмеченную строку это правило не касается
        if (!$force && $existing && $link->fingerprint === $fingerprint) {
            $run->skipped++;
            return;
        }

        if ($lock = $this->lockDate()) {
            if ($date->toDateString() <= $lock) {
                $run->failed++;
                $this->warn($this->label($invoice) . " — период закрыт по {$lock}, накладная пропущена");
                return;
            }
        }

        $supplierId = $this->resolveSupplier($invoice, $cfg);
        $rubles     = round(((int) ($invoice['amount'] ?? 0)) / 100, 2);
        $vat        = (int) ($invoice['vat_amount'] ?? 0);

        DB::connection($this->conn)->transaction(function () use (
            $invoice, $cfg, $date, $rubles, $vat, $supplierId, $externalId, $link, $existing, $run
        ) {
            $doc = $existing ?: (new Document)->setConnection($this->conn);

            $doc->fill([
                'date'            => $date,
                'number'          => $invoice['doc_number'] ?? null,
                'external_number' => $invoice['doc_number'] ?? null,
                'external_date'   => $this->parse($invoice['doc_date'] ?? null)?->toDateString(),
                'project_id'      => $cfg['project_id'],
                'type'            => 'incoming_invoice',
                'bi_id'           => $cfg['header_bi_id'],
                'info_1_id'       => $supplierId,
                'amount'          => $rubles,
                'amount_vat'      => $vat > 0 ? round($vat / 100, 2) : null,
                'note'            => $this->buildNote($invoice),
                'extra'           => [
                    'source'          => 'fusionpos',
                    'integration_id'  => $this->integration->id,
                    'uuid'            => $externalId,
                    'warehouse_id'    => $invoice['warehouse_id'] ?? null,
                    'legal_entity_id' => $invoice['legal_entity_id'] ?? null,
                    'amount_kop'      => (int) ($invoice['amount'] ?? 0),
                ],
            ]);
            if (!$doc->exists) $doc->status = 'draft';
            $doc->save();

            // Строка всегда одна: правило «всё на служебную позицию» делает
            // разбор позиций накладной бессмысленным
            DocumentItem::on($this->conn)->where('document_id', $doc->id)->delete();

            $item = (new DocumentItem)->setConnection($this->conn);
            $item->fill([
                'document_id' => $doc->id,
                'sort_order'  => 0,
                'bi_id'       => $cfg['line_bi_id'],
                'info_1_id'   => $cfg['service_product_id'],
                'quantity'    => $rubles,   // количество = рубли, цена = 1
                'price'       => 1,
                'amount'      => $rubles,
                'content'     => $this->buildContent($invoice),
            ]);
            $item->save();

            if ($cfg['post_documents']) {
                DocumentService::post($doc);
            } else {
                $doc->content = DocumentService::strategy('incoming_invoice')->buildContent($doc);
                $doc->save();
            }

            $this->saveLink($link, $externalId, $doc->id, $this->fingerprint($invoice, $cfg));

            $existing ? $run->updated++ : $run->created++;
        });
    }

    // ─── Удалённые в источнике ───────────────────────────────────────

    /**
     * FUSIONPOS по умолчанию не отдаёт удалённые накладные — они просто
     * исчезают из выдачи. Без отдельного прохода наш документ остался бы
     * проведённым, и обороты разошлись бы с источником молча.
     */
    private function removeDeleted(array $query, IntegrationRun $run, ?array $pick = null): void
    {
        $query['is_deleted'] = 'true';
        unset($query['is_processed']);

        $this->client->each('warehouse/invoices', $query, function (array $items) use ($run, $pick) {
            foreach ($items as $invoice) {
                $externalId = $this->externalId($invoice);
                if ($externalId === '') continue;
                if ($pick !== null && !isset($pick[$externalId])) continue;

                $link = IntegrationLink::on($this->conn)
                    ->where('integration_id', $this->integration->id)
                    ->where('entity', self::ENTITY)
                    ->where('external_id', $externalId)
                    ->first();

                if (!$link) continue;

                $doc = Document::on($this->conn)->find($link->local_id);
                if ($doc) {
                    DocumentService::cancel($doc);   // снимает операции
                    $doc->delete();                   // мягкое удаление, след остаётся
                    $this->warn($this->label($invoice) . ' — удалена в FUSIONPOS, документ снят с проведения');
                }
                $link->delete();
                $run->updated++;
            }
        });
    }

    // ─── Поставщик ───────────────────────────────────────────────────

    /**
     * Режим «по ИНН» заводит контрагента в справочнике при первой встрече.
     * Без ИНН опознать поставщика надёжно нельзя — такие уходят на служебного,
     * иначе от опечаток в названиях справочник за месяц зарастёт двойниками.
     */
    private function resolveSupplier(array $invoice, array $cfg): int
    {
        if ($cfg['supplier_mode'] !== 'by_inn') {
            return $cfg['service_supplier_id'];
        }

        $supplierId = $invoice['supplier_id'] ?? null;
        if ($supplierId && isset($this->supplierById[$supplierId])) {
            return $this->supplierById[$supplierId];
        }

        $inn  = trim((string) data_get($invoice, 'supplier.inn', ''));
        $name = trim((string) (data_get($invoice, 'supplier.name') ?: data_get($invoice, 'supplier.reverse_name') ?: ''));

        if ($inn === '') {
            $this->warn($this->label($invoice) . ' — у поставщика нет ИНН, отнесена на служебного');
            return $cfg['service_supplier_id'];
        }

        $info = Info::on($this->conn)->where('type', 'partner')->where('inn', $inn)->first();

        if (!$info) {
            $info = (new Info)->setConnection($this->conn);
            $info->fill([
                'type'        => 'partner',
                'name'        => $name !== '' ? $name : "ИНН {$inn}",
                'inn'         => $inn,
                'description' => 'Заведён автоматически из FUSIONPOS',
                'is_active'   => true,
            ]);
            $info->save();
        }

        if ($supplierId) $this->supplierById[$supplierId] = $info->id;

        return $info->id;
    }

    // ─── Вспомогательное ─────────────────────────────────────────────

    /** Проверяем настройки заранее: на середине загрузки падать некрасиво. */
    private function config(): array
    {
        $i = $this->integration;

        $headerBiId = DB::connection($this->conn)->table('balance_items')
            ->where('code', self::HEADER_CODE)->value('id');

        if (!$headerBiId) {
            throw new RuntimeException('В плане счетов нет счёта ' . self::HEADER_CODE . ' «Поставщики»');
        }

        $required = [
            'project_id'          => 'проект',
            'line_bi_id'          => 'счёт прихода',
            'service_product_id'  => 'служебная номенклатура',
            'service_supplier_id' => 'служебный поставщик',
        ];
        foreach ($required as $key => $label) {
            if (!$i->setting($key)) {
                throw new RuntimeException("В настройках интеграции не заполнено: {$label}");
            }
        }

        return [
            'header_bi_id'        => (int) $headerBiId,
            'project_id'          => (int) $i->setting('project_id'),
            'line_bi_id'          => (int) $i->setting('line_bi_id'),
            'service_product_id'  => (int) $i->setting('service_product_id'),
            'service_supplier_id' => (int) $i->setting('service_supplier_id'),
            'supplier_mode'       => $i->setting('supplier_mode', 'by_inn'),
            'date_field'          => $i->setting('date_field', 'doc_date'),
            'only_processed'      => (bool) $i->setting('only_processed', true),
            'post_documents'      => (bool) $i->setting('post_documents', true),
            'warehouse_ids'       => array_filter((array) $i->setting('warehouse_ids', [])),
            'legal_entity_ids'    => array_filter((array) $i->setting('legal_entity_ids', [])),
        ];
    }

    private function resolveDate(array $invoice, string $field): ?Carbon
    {
        $primary  = $field === 'processed_at' ? 'processed_at' : 'doc_date';
        $fallback = $primary === 'doc_date' ? 'processed_at' : 'doc_date';

        return $this->parse($invoice[$primary] ?? null) ?? $this->parse($invoice[$fallback] ?? null);
    }

    private function parse(?string $value): ?Carbon
    {
        if (!$value) return null;
        try { return Carbon::parse($value); } catch (\Throwable) { return null; }
    }

    /**
     * Отпечаток значимых полей. Меняется только то, что влияет на документ:
     * правка комментария в FUSIONPOS не должна вызывать перепроведение.
     */
    private function fingerprint(array $invoice, array $cfg): string
    {
        return sha1(json_encode([
            $invoice['doc_number']      ?? null,
            $invoice['doc_date']        ?? null,
            $invoice['processed_at']    ?? null,
            $invoice['supplier_id']     ?? null,
            $invoice['amount']          ?? null,
            $invoice['vat_amount']      ?? null,
            $invoice['warehouse_id']    ?? null,
            $invoice['legal_entity_id'] ?? null,
            // Настройки тоже входят: сменили счёт прихода — документы должны
            // перестроиться, а не остаться на старом
            $cfg['line_bi_id'], $cfg['service_product_id'],
            $cfg['project_id'], $cfg['supplier_mode'], $cfg['post_documents'],
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

    private function buildContent(array $invoice): string
    {
        $parts = ['Поставка FUSIONPOS'];
        if ($w = data_get($invoice, 'warehouse.name')) $parts[] = "склад {$w}";
        if ($n = ($invoice['doc_number'] ?? null))     $parts[] = "№{$n}";
        return implode(', ', $parts);
    }

    private function buildNote(array $invoice): string
    {
        $parts = [];
        if ($n = data_get($invoice, 'supplier.name'))     $parts[] = $n;
        if ($i = data_get($invoice, 'supplier.inn'))      $parts[] = "ИНН {$i}";
        if ($w = data_get($invoice, 'warehouse.name'))    $parts[] = "склад: {$w}";
        if ($l = data_get($invoice, 'legalEntity.name'))  $parts[] = "юрлицо: {$l}";
        if ($c = ($invoice['comment'] ?? null))           $parts[] = $c;
        $parts[] = 'FUSIONPOS ' . ($invoice['uuid'] ?? $invoice['id'] ?? '');

        return implode(', ', $parts);
    }

    private function label(array $invoice): string
    {
        $n = $invoice['doc_number'] ?? ('id ' . ($invoice['id'] ?? '?'));
        $d = $this->parse($invoice['doc_date'] ?? $invoice['processed_at'] ?? null);
        return 'Накладная ' . $n . ($d ? ' от ' . $d->format('d.m.Y') : '');
    }

    /**
     * Дата запрета читается один раз за загрузку.
     *
     * Кэш именно в объекте, а не в static: воркер очереди живёт долго и
     * обслуживает разные компании подряд — статическая переменная утащила бы
     * дату запрета одного тенанта в загрузку другого.
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
