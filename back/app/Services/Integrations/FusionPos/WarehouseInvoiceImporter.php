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

    private string  $conn;
    private array   $details      = [];
    private array   $supplierById = [];  // кэш: id поставщика FUSIONPOS → id в справочнике
    private bool    $lockLoaded   = false;
    private ?string $lockValue    = null;

    public function __construct(
        private FusionPosClient $client,
        private Integration $integration,
    ) {
        $this->conn = $integration->getConnectionName();
    }

    public function run(IntegrationRun $run, string $from, string $to): void
    {
        $cfg = $this->config();

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

        $this->client->each('warehouse/invoices', $query, function (array $items) use ($run, $cfg) {
            foreach ($items as $invoice) {
                $run->fetched++;
                try {
                    $this->importOne($invoice, $run, $cfg);
                } catch (\Throwable $e) {
                    $run->failed++;
                    $this->warn($this->label($invoice) . ' — ' . $e->getMessage());
                }
            }
        });

        $this->removeDeleted($query, $run);

        $run->details = $this->details ?: null;
    }

    // ─── Одна накладная ──────────────────────────────────────────────

    private function importOne(array $invoice, IntegrationRun $run, array $cfg): void
    {
        $externalId = (string) ($invoice['uuid'] ?? $invoice['id'] ?? '');
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
        // перепроводила бы весь период и переписывала ручные правки
        if ($existing && $link->fingerprint === $fingerprint) {
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
    private function removeDeleted(array $query, IntegrationRun $run): void
    {
        $query['is_deleted'] = 'true';
        unset($query['is_processed']);

        $this->client->each('warehouse/invoices', $query, function (array $items) use ($run) {
            foreach ($items as $invoice) {
                $externalId = (string) ($invoice['uuid'] ?? $invoice['id'] ?? '');
                if ($externalId === '') continue;

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
