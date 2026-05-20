<?php

namespace App\Console\Commands;

use App\Services\TenantService;
use App\Services\Documents\DocumentService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Бенчмарк ключевых операций FINDIR под MySQL vs MariaDB.
 *
 * Запуск (MySQL):
 *   docker exec findir_php php artisan findir:benchmark --tenant=bench --label=mysql
 *
 * Запуск (MariaDB):
 *   docker exec -e DB_HOST=mariadb findir_php php artisan findir:benchmark --tenant=bench --label=mariadb
 */
class BenchmarkCommand extends Command
{
    protected $signature = 'findir:benchmark
                            {--tenant=bench : Slug тенанта для тестов}
                            {--label=mysql  : Метка для файла результатов}
                            {--incoming=20  : Сколько приходных накладных создать}
                            {--outgoing=20  : Сколько расходных создать}
                            {--items=30     : Строк в каждой накладной}
                            {--osv-runs=10  : Сколько раз гонять ОСВ}
                            {--skip-prepare : Пропустить --fresh --seed (если данные уже есть)}';

    protected $description = 'Бенчмарк ключевых сценариев FINDIR для сравнения СУБД';

    private array $results = [];

    public function handle(): int
    {
        $tenant   = $this->option('tenant');
        $label    = $this->option('label');
        $nIn      = (int)$this->option('incoming');
        $nOut     = (int)$this->option('outgoing');
        $nItems   = (int)$this->option('items');
        $nOsv     = (int)$this->option('osv-runs');

        $this->info("════════════════════════════════════════════");
        $this->info("  FINDIR Benchmark — {$label}");
        $this->info("════════════════════════════════════════════");
        $this->line("Tenant:   {$tenant}");
        $this->line("Incoming: {$nIn} × {$nItems} строк");
        $this->line("Outgoing: {$nOut} × {$nItems} строк");
        $this->line("OSV runs: {$nOsv}");
        $this->line("");

        // 1. Подготовка
        if (!$this->option('skip-prepare')) {
            $this->prepare($tenant);
        }

        // ВАЖНО: переключаем дефолтное соединение Laravel на тенантную БД,
        // чтобы DB::table() работал с findir_bench, а не с findir_central.
        $dbName = TenantService::connect($tenant);
        DB::setDefaultConnection($dbName);

        $version = DB::selectOne('SELECT VERSION() as v')->v ?? 'unknown';
        $this->line("DB version: {$version}");
        $this->line("DB name:    {$dbName}");
        $this->line("");

        // 2. Контекст из сидов
        $ctx = $this->loadSeedContext();

        // 3. Приходные накладные
        $this->info("→ Приходные накладные ({$nIn} шт × {$nItems} строк)");
        $tStart = microtime(true);
        for ($i = 0; $i < $nIn; $i++) {
            $this->createAndPostIncoming($ctx, $nItems, $i);
        }
        $elapsedIn = microtime(true) - $tStart;
        $this->logResult("incoming_post_total_ms", round($elapsedIn * 1000, 2));
        $this->logResult("incoming_post_avg_ms",   round(($elapsedIn / $nIn) * 1000, 2));
        $this->line("  Всего: " . round($elapsedIn, 2) . "s, среднее: " . round($elapsedIn / $nIn * 1000, 2) . "ms на документ");

        // 4. Расходные накладные
        $this->info("→ Расходные накладные ({$nOut} шт × {$nItems} строк)");
        $tStart = microtime(true);
        for ($i = 0; $i < $nOut; $i++) {
            $this->createAndPostOutgoing($ctx, $nItems, $i);
        }
        $elapsedOut = microtime(true) - $tStart;
        $this->logResult("outgoing_post_total_ms", round($elapsedOut * 1000, 2));
        $this->logResult("outgoing_post_avg_ms",   round(($elapsedOut / $nOut) * 1000, 2));
        $this->line("  Всего: " . round($elapsedOut, 2) . "s, среднее: " . round($elapsedOut / $nOut * 1000, 2) . "ms на документ");

        // 5. Целостность
        $bcCount = DB::table('balance_changes')->count();
        $this->logResult("balance_changes_rows", $bcCount);
        $this->line("balance_changes: {$bcCount} строк");

        // 6. ОСВ
        $this->info("→ ОСВ-запросы ({$nOsv} прогонов)");
        $tStart = microtime(true);
        for ($i = 0; $i < $nOsv; $i++) {
            $this->runOsvQuery();
        }
        $elapsedOsv = microtime(true) - $tStart;
        $this->logResult("osv_total_ms",  round($elapsedOsv * 1000, 2));
        $this->logResult("osv_avg_ms",    round(($elapsedOsv / $nOsv) * 1000, 2));
        $this->line("  Всего: " . round($elapsedOsv, 2) . "s, среднее: " . round($elapsedOsv / $nOsv * 1000, 2) . "ms на запрос");

        // 7. Себестоимость
        $this->info("→ Расчёт себестоимости ({$nOut} прогонов)");
        $tStart = microtime(true);
        for ($i = 0; $i < $nOut; $i++) {
            $this->runCostCalculation($ctx);
        }
        $elapsedCost = microtime(true) - $tStart;
        $this->logResult("cost_calc_total_ms", round($elapsedCost * 1000, 2));
        $this->logResult("cost_calc_avg_ms",   round(($elapsedCost / $nOut) * 1000, 2));
        $this->line("  Всего: " . round($elapsedCost, 2) . "s, среднее: " . round($elapsedCost / $nOut * 1000, 2) . "ms");

        // 8. Сохраняем
        $out = [
            'label'       => $label,
            'db_version'  => $version,
            'tenant'      => $tenant,
            'params'      => [
                'incoming' => $nIn,
                'outgoing' => $nOut,
                'items'    => $nItems,
                'osv_runs' => $nOsv,
            ],
            'results'     => $this->results,
            'timestamp'   => date('c'),
        ];
        $file = "/tmp/findir-bench-{$label}.json";
        file_put_contents($file, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

        $this->line("");
        $this->info("✓ Готово. Результат: {$file}");

        return self::SUCCESS;
    }

    private function prepare(string $slug): void
    {
        // Запись в центральной БД (если её нет)
        $exists = DB::table('tenants')->where('id', $slug)->exists();
        if (!$exists) {
            DB::table('tenants')->insert([
                'id'         => $slug,
                'name'       => 'Benchmark Tenant',
                'plan'       => 'trial',
                'status'     => 'active',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            $this->line("  → Создан tenant '{$slug}' в центральной БД");
        }

        $this->line("  → tenants:migrate --fresh --seed");
        $this->call('tenants:migrate', [
            '--tenant' => $slug,
            '--fresh'  => true,
            '--seed'   => true,
            '--force'  => true,
        ]);
    }

    private function loadSeedContext(): array
    {
        $projectId = DB::table('projects')->value('id');
        if (!$projectId) {
            // Сидер не создал проект — создаём вручную
            $projectId = DB::table('projects')->insertGetId([
                'name'       => 'Бенчмарк проект',
                'currency'   => 'RUB',
                'timezone'   => 'Europe/Moscow',
                'created_at' => now(), 'updated_at' => now(),
            ]);
            $this->line("  → Создан проект id={$projectId}");
        }

        $accounts = DB::table('balance_items')->whereIn('code', ['А200', 'А405', 'П100', 'П587', 'П588'])
            ->pluck('id', 'code')->toArray();

        if (empty($accounts['А200']) || empty($accounts['А405']) || empty($accounts['П100'])) {
            throw new \RuntimeException(
                'Нет ключевых счетов (А200/А405/П100) в balance_items. Сидер не отработал?'
            );
        }

        $partners = DB::table('info')->where('type', 'partner')->limit(5)->pluck('id')->toArray();
        $products = DB::table('info')->where('type', 'product')->limit(10)->pluck('id')->toArray();

        if (empty($partners)) {
            for ($i = 0; $i < 5; $i++) {
                $partners[] = DB::table('info')->insertGetId([
                    'code'       => "P{$i}",
                    'name'       => "Партнёр {$i}",
                    'type'       => 'partner',
                    'is_active'  => 1,
                    'created_at' => now(), 'updated_at' => now(),
                ]);
            }
        }
        if (empty($products)) {
            for ($i = 0; $i < 10; $i++) {
                $products[] = DB::table('info')->insertGetId([
                    'code'       => "T{$i}",
                    'name'       => "Товар {$i}",
                    'type'       => 'product',
                    'is_active'  => 1,
                    'created_at' => now(), 'updated_at' => now(),
                ]);
            }
        }

        return [
            'project_id' => $projectId,
            'A200'       => $accounts['А200'] ?? null,
            'A405'       => $accounts['А405'] ?? null,
            'P100'       => $accounts['П100'] ?? null,
            'P587'       => $accounts['П587'] ?? null,
            'P588'       => $accounts['П588'] ?? null,
            'partners'   => $partners,
            'products'   => $products,
        ];
    }

    private function createAndPostIncoming(array $ctx, int $nItems, int $idx): int
    {
        $docId = DB::table('documents')->insertGetId([
            'date'          => now()->subDays(rand(1, 90)),
            'number'        => "IN-{$idx}",
            'project_id'    => $ctx['project_id'],
            'type'          => 'incoming_invoice',
            'status'        => 'draft',
            'bi_id'         => $ctx['P100'],
            'info_1_id'     => $ctx['partners'][array_rand($ctx['partners'])],
            'amount'        => 0,
            'created_at'    => now(), 'updated_at' => now(),
        ]);
        for ($j = 0; $j < $nItems; $j++) {
            DB::table('document_items')->insert([
                'document_id' => $docId,
                'sort_order'  => $j,
                'bi_id'       => $ctx['A200'],
                'info_1_id'   => $ctx['products'][array_rand($ctx['products'])],
                'quantity'    => rand(1, 100),
                'price'       => rand(100, 10000) / 100,
                'amount'      => rand(1000, 100000) / 100,
                'created_at'  => now(), 'updated_at' => now(),
            ]);
        }
        $doc = \App\Models\Tenant\Document::find($docId);
        DocumentService::post($doc);
        return $docId;
    }

    private function createAndPostOutgoing(array $ctx, int $nItems, int $idx): int
    {
        $docId = DB::table('documents')->insertGetId([
            'date'            => now()->subDays(rand(1, 30)),
            'number'          => "OUT-{$idx}",
            'project_id'      => $ctx['project_id'],
            'type'            => 'outgoing_invoice',
            'status'          => 'draft',
            'bi_id'           => $ctx['A405'],
            'info_1_id'       => $ctx['partners'][array_rand($ctx['partners'])],
            'revenue_bi_id'   => $ctx['P587'],
            'cogs_bi_id'      => $ctx['P588'],
            'amount'          => 0,
            'created_at'      => now(), 'updated_at' => now(),
        ]);
        for ($j = 0; $j < $nItems; $j++) {
            DB::table('document_items')->insert([
                'document_id' => $docId,
                'sort_order'  => $j,
                'bi_id'       => $ctx['A200'],
                'info_1_id'   => $ctx['products'][array_rand($ctx['products'])],
                'quantity'    => rand(1, 10),
                'price'       => rand(500, 20000) / 100,
                'amount'      => rand(5000, 200000) / 100,
                'created_at'  => now(), 'updated_at' => now(),
            ]);
        }
        $doc = \App\Models\Tenant\Document::find($docId);
        DocumentService::post($doc);
        return $docId;
    }

    private function runOsvQuery(): void
    {
        DB::table('balance_changes')
            ->selectRaw('
                bi_id,
                info_1_id,
                info_2_id,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as debit,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) as credit,
                SUM(amount)    as balance,
                SUM(quantity)  as quantity_balance,
                COUNT(*)       as ops
            ')
            ->whereBetween('date', [now()->subYear(), now()])
            ->groupBy('bi_id', 'info_1_id', 'info_2_id')
            ->orderBy('bi_id')
            ->get();
    }

    private function runCostCalculation(array $ctx): void
    {
        DB::table('balance_changes')
            ->selectRaw('
                bi_id, info_1_id, info_2_id,
                SUM(amount)   as amount_sum,
                SUM(quantity) as qty_sum
            ')
            ->where('bi_id', $ctx['A200'])
            ->where('date', '<', now())
            ->groupBy('bi_id', 'info_1_id', 'info_2_id')
            ->get();
    }

    private function logResult(string $key, float|int $value): void
    {
        $this->results[$key] = $value;
    }
}
