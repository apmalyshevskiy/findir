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

        // ── просмотр и загрузка отмеченных ───────────────────────────
        $this->resetData($conn);

        $this->fake([$this->inv(1, 'ТН-001', 150000, '7704217370', 'ООО Ромашка'),
                     $this->inv(2, 'ТН-002',  47550, '500100732259', 'ИП Петров'),
                     $this->inv(3, 'ТН-003',  10000, null, 'Без ИНН')]);

        $seen = $this->preview($integration);
        $this->ok(count($seen) === 3, 'просмотр показал 3 накладные');
        $this->ok($seen['ТН-001'] === 'new', 'незагруженная помечена «новая»');
        $this->ok(Document::on($conn)->count() === 0, 'просмотр ничего не записал в базу');

        // Берём только одну из трёх
        $run6 = $this->sync($integration, $conn, ['uuid-2']);
        $this->ok($run6->created === 1, "загружена только отмеченная (создано {$run6->created})");
        $this->ok(Document::on($conn)->count() === 1, 'остальные не тронуты');

        $seen2 = $this->preview($integration);
        $this->ok($seen2['ТН-002'] === 'loaded', 'загруженная помечена «уже загружена»');
        $this->ok($seen2['ТН-001'] === 'new', 'непогруженная так и осталась новой');

        // Меняем сумму загруженной — просмотр должен это заметить
        $this->fake([$this->inv(1, 'ТН-001', 150000, '7704217370', 'ООО Ромашка'),
                     $this->inv(2, 'ТН-002',  99900, '500100732259', 'ИП Петров'),
                     $this->inv(3, 'ТН-003',  10000, null, 'Без ИНН')]);
        $seen3 = $this->preview($integration);
        $this->ok($seen3['ТН-002'] === 'changed', 'изменившаяся помечена «изменилась»');

        // Повторная загрузка уже загруженной: отметили руками — значит грузим
        $this->fake([$this->inv(1, 'ТН-001', 150000, '7704217370', 'ООО Ромашка'),
                     $this->inv(2, 'ТН-002',  47550, '500100732259', 'ИП Петров'),
                     $this->inv(3, 'ТН-003',  10000, null, 'Без ИНН')]);
        $run7 = $this->sync($integration, $conn, ['uuid-2']);
        $this->ok($run7->updated === 1 && $run7->skipped === 0,
                  "отмеченная перезагружается, а не пропускается (обновлено {$run7->updated}, пропущено {$run7->skipped})");
        $this->ok(Document::on($conn)->count() === 1, 'повторная загрузка не создала дубль');
        $this->ok(DB::connection($conn)->table('operations')->where('table_name', 'documents')->count() === 1,
                  'операции не задвоились');

        // Без отметок бережная логика на месте
        $run8 = $this->sync($integration, $conn);
        $this->ok($run8->skipped === 1 && $run8->updated === 0,
                  "без отметок неизменившееся пропускается (пропущено {$run8->skipped})");

        // Состав и разноска одной накладной
        $detail = IntegrationRegistry::driver($integration)
            ->object($integration, 'warehouse_invoice', 'uuid-2');
        $this->ok(count($detail['items']) === 3, 'в составе 3 позиции (факт ' . count($detail['items']) . ')');
        $this->ok($detail['items'][0]['name'] === 'Молоко', 'название с первой страницы справочника: ' . $detail['items'][0]['name']);
        // Позиция со второй страницы: фильтра по списку id в FUSIONPOS нет,
        // поэтому справочник должен вычитываться целиком
        $this->ok($detail['items'][2]['name'] === 'Позиция 125',
                  'название со второй страницы справочника: ' . $detail['items'][2]['name']);
        $this->ok(!str_contains(json_encode($detail['items'], JSON_UNESCAPED_UNICODE), 'позиция #'),
                  'ни одна позиция не осталась без названия');
        $this->ok($detail['supplier'] === 'ИП Петров' && $detail['inn'] === '500100732259', 'контрагент и ИНН показаны');
        $this->ok(abs($detail['posting']['amount'] - 475.50) < 0.01, 'разноска: сумма 475.50');
        $this->ok((float) $detail['posting']['price'] === 1.0, 'разноска: цена 1 ₽');
        $this->ok(str_contains((string) $detail['posting']['credit'], 'П100'), 'разноска: кредит П100');
        $this->ok($detail['document_id'] !== null, 'ссылка на наш документ есть');

        // Удалённая в источнике — своя пометка
        $this->fake([$this->inv(1, 'ТН-001', 150000, '7704217370', 'ООО Ромашка')],
                    [$this->inv(2, 'ТН-002', 99900, '500100732259', 'ИП Петров')]);
        $seen4 = $this->preview($integration);
        $this->ok(($seen4['ТН-002'] ?? null) === 'deleted', 'удалённая в источнике помечена «удалена»');

        $this->resetData($conn);

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

    private function preview(Integration $i): array
    {
        $rows = IntegrationRegistry::driver($i)
            ->preview($i, 'warehouse_invoice', '2026-07-01', '2026-07-31');

        return array_column($rows, 'status', 'number');
    }

    private function sync(Integration $i, string $conn, ?array $only = null): IntegrationRun
    {
        $run = (new IntegrationRun)->setConnection($conn);
        $run->fill(['integration_id' => $i->id, 'entity' => 'warehouse_invoice',
                    'period_from' => '2026-07-01', 'period_to' => '2026-07-31',
                    'status' => 'running', 'started_at' => now(),
                    'fetched' => 0, 'created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0]);
        $run->save();

        IntegrationRegistry::driver($i)->sync($i, $run, '2026-07-01', '2026-07-31', $only);
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
            $url = (string) $request->url();

            if (str_contains($url, 'nomenclatures')) {
                // Как настоящий FUSIONPOS: фильтр id принимает одно число,
                // списком через запятую не работает. Справочник отдаётся
                // страницами — иначе проверка не поймала бы разбор страниц
                if (preg_match('~[?&]id=([^&]*)~', $url, $m) && str_contains(urldecode($m[1]), ',')) {
                    return Http::response(['items' => [], '_meta' => ['totalCount' => 0, 'pageCount' => 1]]);
                }

                $all   = [];
                for ($i = 101; $i <= 130; $i++) $all[] = ['id' => $i, 'name' => "Позиция {$i}"];
                $all[0]['name'] = 'Молоко';
                $all[1]['name'] = 'Кофе в зёрнах';

                preg_match('~[?&]page=(\d+)~', $url, $pm);
                $page  = (int) ($pm[1] ?? 1);
                $chunk = array_slice($all, ($page - 1) * 20, 20);

                return Http::response(['items' => $chunk,
                    '_meta' => ['totalCount' => count($all), 'pageCount' => 2, 'currentPage' => $page]]);
            }

            if (str_contains($url, 'warehouse/invoices')) {
                $body = str_contains($url, 'is_deleted=true') ? $deleted : $items;

                // Запрос одной накладной по uuid — так ходит показ состава
                if (preg_match('~[?&]uuid=([^&]+)~', $url, $m)) {
                    $wanted = urldecode($m[1]);
                    $body = array_values(array_filter(
                        array_merge($items, $deleted),
                        fn($i) => ($i['uuid'] ?? null) === $wanted
                    ));
                }

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
            // Состав в учёт не переносится, но показывается справочно
            'warehouseInvoiceItems' => [
                ['nomenclature_id' => 101, 'quantity' => 10, 'price' => (int) round($kopecks * 0.5 / 10), 'amount' => (int) round($kopecks * 0.5)],
                ['nomenclature_id' => 102, 'quantity' => 4,  'price' => (int) round($kopecks * 0.3 / 4),  'amount' => (int) round($kopecks * 0.3)],
                // Со второй страницы справочника — проверяем разбор страниц
                ['nomenclature_id' => 125, 'quantity' => 2,  'price' => (int) round($kopecks * 0.2 / 2),  'amount' => (int) round($kopecks * 0.2)],
            ],
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

    /** Между блоками проверок чистим только данные, интеграцию оставляем. */
    private function resetData(string $conn): void
    {
        if (!$this->since) return;

        DB::connection($conn)->table('operations')
            ->where('table_name', 'documents')->where('id', '>', $this->since['operations'])->delete();
        DB::connection($conn)->table('document_items')
            ->where('id', '>', $this->since['document_items'])->delete();
        DB::connection($conn)->table('documents')
            ->where('id', '>', $this->since['documents'])->delete();
        DB::connection($conn)->table('integration_links')->delete();
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
