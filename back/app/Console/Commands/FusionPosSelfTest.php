<?php

namespace App\Console\Commands;

use App\Models\Tenant\Document;
use App\Models\Tenant\Info;
use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationRun;
use App\Services\Integrations\IntegrationRegistry;
use App\Services\TenantService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/**
 * Прогон импорта накладных на поддельном FUSIONPOS.
 *
 * Проверяет то, что на живом API проверить дорого: повторную загрузку,
 * изменение суммы, удаление накладной в источнике и отказ в закрытый период.
 * Работает на указанном тенанте и за собой прибирает.
 *
 *   php artisan fusionpos:selftest <тенант>
 */
class FusionPosSelfTest extends Command
{
    protected $signature   = 'fusionpos:selftest {tenant}';
    protected $description = 'Самопроверка импорта приходных накладных FUSIONPOS на фейковом API';

    private int   $bad   = 0;
    private array $since    = [];   // максимальные id до прогона
    private int   $bcBefore = 0;

    public function handle(): int
    {
        $tenant = $this->argument('tenant');
        $conn   = TenantService::connect($tenant);

        if (!$this->guard($conn, $tenant)) return 1;

        // Границы «своих» строк: всё, что появится дальше, создано прогоном
        $this->since = [
            'documents'      => (int) DB::connection($conn)->table('documents')->max('id'),
            'document_items' => (int) DB::connection($conn)->table('document_items')->max('id'),
            'operations'     => (int) DB::connection($conn)->table('operations')->max('id'),
            'info'           => (int) DB::connection($conn)->table('info')->max('id'),
        ];
        $this->bcBefore = DB::connection($conn)->table('balance_changes')->count();

        // ── подготовка справочников ──────────────────────────────────
        $projectId = DB::connection($conn)->table('projects')->value('id');
        $headerBi  = DB::connection($conn)->table('balance_items')->where('code', 'П100')->value('id');
        $lineBi     = DB::connection($conn)->table('balance_items')->where('code', 'А200')->value('id');
        $this->line("проект=$projectId  П100=$headerBi  А200=$lineBi");

        $product = $this->makeInfo($conn, 'product', 'Служебная позиция (поставки)');
        $partner = $this->makeInfo($conn, 'partner', 'Служебный поставщик');

        $integration = (new Integration)->setConnection($conn);
        $integration->fill([
            'type' => 'fusionpos', 'name' => 'Тест FUSIONPOS', 'is_active' => true,
            'settings' => [
                'project_id'          => $projectId,
                'line_bi_id'          => $lineBi,
                'service_product_id'  => $product,
                'service_supplier_id' => $partner,
                'supplier_mode'       => 'by_inn',
                'date_field'          => 'doc_date',
                'only_processed'      => true,
                'post_documents'      => true,
            ],
        ]);
        $integration->setCredentials(['domain' => 'test.fusionpos.ru', 'token' => 'FAKE']);
        $integration->save();

        // ── прогон 1: три накладные ──────────────────────────────────
        $this->fake([$this->inv(1, 'ТН-001', 150000, '7704217370', 'ООО Ромашка'),
                     $this->inv(2, 'ТН-002',  47550, '500100732259', 'ИП Петров'),
                     $this->inv(3, 'ТН-003',  10000, null, 'Без ИНН')]);

        $run = $this->sync($integration, $conn);
        $this->ok($run->fetched === 3, "получено 3 (факт {$run->fetched})");
        $this->ok($run->created === 3, "создано 3 (факт {$run->created})");

        $docs = Document::on($conn)->where('type', 'incoming_invoice')->get();
        $this->ok($docs->count() === 3, 'создано 3 документа');
        $this->ok(abs($docs->sum('amount') - 2075.50) < 0.01,
                  'сумма 2075.50 ₽ = (150000+47550+10000)/100, факт ' . $docs->sum('amount'));

        $item = DB::connection($conn)->table('document_items')
            ->where('document_id', $docs->firstWhere('external_number', 'ТН-001')->id)->first();
        $this->ok((float) $item->price === 1.0, 'цена = 1 ₽');
        $this->ok(abs($item->quantity - 1500) < 0.001, 'количество = рубли (1500)');
        $this->ok(abs($item->amount - 1500) < 0.01, 'сумма строки = 1500');
        $this->ok((int) $item->info_1_id === $product, 'строка на служебную номенклатуру');

        // Поставщики: двое заведены по ИНН, третий ушёл на служебного
        $romashka = Info::on($conn)->where('type', 'partner')->where('inn', '7704217370')->first();
        $this->ok((bool) $romashka, 'поставщик заведён по ИНН');
        $this->ok($romashka?->name === 'ООО Ромашка', 'имя поставщика перенесено');
        $noInn = $docs->firstWhere('external_number', 'ТН-003');
        $this->ok((int) $noInn->info_1_id === $partner, 'без ИНН → служебный поставщик');

        // Проводки
        $ops = DB::connection($conn)->table('operations')->where('table_name', 'documents')->get();
        $this->ok($ops->count() === 3, "операций 3 (факт {$ops->count()})");
        $this->ok(abs($ops->sum('amount') - 2075.50) < 0.01, 'сумма операций сходится');
        $this->ok((int) $ops->first()->in_bi_id === (int) $lineBi, 'дебет — счёт прихода');
        $this->ok((int) $ops->first()->out_bi_id === (int) $headerBi, 'кредит — П100 Поставщики');

        // Считаем прирост, а не общее число: по две записи на операцию
        $bc = DB::connection($conn)->table('balance_changes')->count() - $this->bcBefore;
        $this->ok($bc === 6, "обороты собраны триггерами: +6 (факт +{$bc})");

        // ── прогон 2: ничего не изменилось ───────────────────────────
        $run2 = $this->sync($integration, $conn);
        $this->ok($run2->skipped === 3 && $run2->created === 0,
                  "повтор без изменений: пропущено {$run2->skipped}, создано {$run2->created}");
        $this->ok(Document::on($conn)->count() === 3, 'дубли не появились');

        // ── прогон 3: сумма изменилась ───────────────────────────────
        $this->fake([$this->inv(1, 'ТН-001', 200000, '7704217370', 'ООО Ромашка'),
                     $this->inv(2, 'ТН-002',  47550, '500100732259', 'ИП Петров'),
                     $this->inv(3, 'ТН-003',  10000, null, 'Без ИНН')]);
        $run3 = $this->sync($integration, $conn);
        $this->ok($run3->updated === 1 && $run3->skipped === 2,
                  "изменённая перезалита: обновлено {$run3->updated}, пропущено {$run3->skipped}");
        $this->ok(abs(Document::on($conn)->sum('amount') - 2575.50) < 0.01, 'новая сумма 2575.50');
        $this->ok(DB::connection($conn)->table('operations')->where('table_name', 'documents')->count() === 3,
                  'операции не задвоились при перепроведении');

        // ── прогон 4: накладную удалили в FUSIONPOS ──────────────────
        $this->fake([$this->inv(2, 'ТН-002', 47550, '500100732259', 'ИП Петров'),
                     $this->inv(3, 'ТН-003', 10000, null, 'Без ИНН')],
                    [$this->inv(1, 'ТН-001', 200000, '7704217370', 'ООО Ромашка')]);
        $this->sync($integration, $conn);
        $this->ok(Document::on($conn)->count() === 2, 'удалённая в источнике снята');
        $this->ok(DB::connection($conn)->table('operations')->where('table_name', 'documents')->count() === 2,
                  'её операции убраны');
        $this->ok(abs(Document::on($conn)->sum('amount') - 575.50) < 0.01, 'остаток 575.50');

        // ── закрытый период ──────────────────────────────────────────
        DB::connection($conn)->table('settings')->updateOrInsert(
            ['key' => 'edit_lock_date'],
            ['value' => '2026-12-31', 'created_at' => now(), 'updated_at' => now()]
        );
        $this->fake([$this->inv(9, 'ТН-009', 33300, '7704217370', 'ООО Ромашка')]);
        $run5 = $this->sync($integration, $conn);
        $this->ok($run5->failed === 1 && $run5->created === 0, 'в закрытый период не загружает');
        $this->ok(str_contains(implode(' ', $run5->details ?? []), 'период закрыт'),
                  'причина названа: ' . implode(' | ', array_slice($run5->details ?? [], 0, 1)));
        DB::connection($conn)->table('settings')->where('key', 'edit_lock_date')->delete();

        // ── неверный токен ───────────────────────────────────────────
        Http::swap(new \Illuminate\Http\Client\Factory());
        Http::fake(['*' => Http::response(['message' => 'Unauthorized'], 401)]);
        try {
            IntegrationRegistry::driver($integration)->testConnection($integration);
            $this->ok(false, 'ошибка токена должна выбрасываться');
        } catch (\Throwable $e) {
            $this->ok(str_contains($e->getMessage(), 'токен'), 'понятная ошибка: ' . $e->getMessage());
        }

        $this->cleanup($conn);

        $this->newLine();
        $this->line($this->bad ? "ПРОВАЛЕНО: {$this->bad}" : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
        return $this->bad ? 1 : 0;
    }

    // ── вспомогательное ─────────────────────────────────────────────

    private function sync(Integration $i, string $conn): IntegrationRun
    {
        $run = (new IntegrationRun)->setConnection($conn);
        $run->fill(['integration_id' => $i->id, 'entity' => 'warehouse_invoice',
                    'period_from' => '2026-07-01', 'period_to' => '2026-07-31',
                    'status' => 'running', 'started_at' => now(),
                    'fetched' => 0, 'created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0]);
        $run->save();

        IntegrationRegistry::driver($i)->sync($i, $run, '2026-07-01', '2026-07-31');
        $run->save();

        return $run;
    }

    /** Поддельный API: обычная выдача и отдельно — удалённые. */
    private function fake(array $items, array $deleted = []): void
    {
        // Http::fake() докладывает обработчик к прежним, а не заменяет их:
        // без чистой фабрики второй прогон продолжал бы отвечать данными первого
        Http::swap(new \Illuminate\Http\Client\Factory());

        Http::fake(function ($request) use ($items, $deleted) {
            $url  = (string) $request->url();
            $body = str_contains($url, 'is_deleted=true') ? $deleted : $items;

            if (str_contains($url, 'warehouse/invoices')) {
                return Http::response(['items' => $body,
                    '_meta' => ['totalCount' => count($body), 'pageCount' => 1, 'currentPage' => 1]]);
            }
            return Http::response(['items' => [], '_meta' => ['totalCount' => 0, 'pageCount' => 1]]);
        });
    }

    private function inv(int $id, string $number, int $kopecks, ?string $inn, string $name): array
    {
        return [
            'id' => $id, 'uuid' => "uuid-{$id}",
            'doc_number' => $number, 'doc_date' => '2026-07-15 10:00:00',
            'processed_at' => '2026-07-15 12:00:00', 'is_processed' => true,
            'amount' => $kopecks, 'vat_amount' => (int) round($kopecks / 6),
            'supplier_id' => $id * 10, 'warehouse_id' => 1, 'legal_entity_id' => 1,
            'comment' => 'поставка',
            'supplier'    => ['id' => $id * 10, 'name' => $name, 'inn' => $inn],
            'warehouse'   => ['id' => 1, 'name' => 'Основной склад'],
            'legalEntity' => ['id' => 1, 'name' => 'ООО Тест'],
        ];
    }

    private function makeInfo(string $conn, string $type, string $name): int
    {
        $existing = Info::on($conn)->where('type', $type)->where('name', $name)->first();
        if ($existing) return $existing->id;

        $info = (new Info)->setConnection($conn);
        $info->fill(['type' => $type, 'name' => $name, 'is_active' => true]);
        $info->save();
        return $info->id;
    }

    /**
     * Пускаем только в пустую базу.
     *
     * Прогон создаёт и удаляет документы, и на базе с настоящим учётом ему
     * делать нечего: удалить чужую строку здесь стоит дороже, чем не проверить.
     */
    private function guard(string $conn, string $tenant): bool
    {
        $docs = DB::connection($conn)->table('documents')->count();
        $ints = DB::connection($conn)->table('integrations')->count();

        if ($docs === 0 && $ints === 0) return true;

        $this->error("В базе «{$tenant}» уже есть документы ({$docs}) или интеграции ({$ints}).");
        $this->line('Самопроверка удаляет за собой документы и запускается только на пустой базе.');
        $this->line('Заведите отдельного тенанта для проверок.');

        return false;
    }

    /** Убираем ровно то, что создал прогон, — по границе идентификаторов. */
    private function cleanup(string $conn): void
    {
        if (!$this->since) return;

        DB::connection($conn)->table('operations')
            ->where('table_name', 'documents')->where('id', '>', $this->since['operations'])->delete();
        DB::connection($conn)->table('document_items')
            ->where('id', '>', $this->since['document_items'])->delete();
        DB::connection($conn)->table('documents')
            ->where('id', '>', $this->since['documents'])->delete();
        DB::connection($conn)->table('info')
            ->where('id', '>', $this->since['info'])
            ->where('description', 'Заведён автоматически из FUSIONPOS')->delete();

        DB::connection($conn)->table('integration_links')->delete();
        DB::connection($conn)->table('integration_runs')->delete();
        DB::connection($conn)->table('integrations')->delete();
    }

    private function ok(bool $cond, string $message): void
    {
        if (!$cond) $this->bad++;
        $this->line(($cond ? '  OK   ' : '  FAIL ') . $message);
    }
}
