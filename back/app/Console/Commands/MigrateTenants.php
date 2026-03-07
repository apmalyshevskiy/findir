<?php

namespace App\Console\Commands;

use App\Services\TenantService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

class MigrateTenants extends Command
{
    protected $signature = 'tenants:migrate
                            {--tenant= : Slug конкретного тенанта (например: ooo-lbrmts)}
                            {--fresh   : Пересоздать БД с нуля (DROP + migrate)}
                            {--seed    : Запустить сидер после миграций}
                            {--force   : Выполнить без подтверждения}';

    protected $description = 'Применить тенантные миграции ко всем или конкретному тенанту';

    public function handle(): int
    {
        $tenantSlug = $this->option('tenant');

        // Получаем список тенантов
        if ($tenantSlug) {
            $tenants = DB::table('tenants')->where('id', $tenantSlug)->get();
            if ($tenants->isEmpty()) {
                $this->error("Тенант '{$tenantSlug}' не найден.");
                return self::FAILURE;
            }
        } else {
            $tenants = DB::table('tenants')->get();
        }

        if ($tenants->isEmpty()) {
            $this->warn('Нет тенантов в базе данных.');
            return self::SUCCESS;
        }

        $this->info("Найдено тенантов: {$tenants->count()}");

        if ($this->option('fresh') && !$this->option('force')) {
            if (!$this->confirm('--fresh пересоздаст все тенантные БД. Продолжить?')) {
                return self::FAILURE;
            }
        }

        $success = 0;
        $failed  = 0;

        foreach ($tenants as $tenant) {
            $this->line('');
            $this->line("──────────────────────────────────");
            $this->info("Тенант: {$tenant->id}");

            try {
                $dbName = TenantService::connect($tenant->id);

                // Создаём БД если не существует
                DB::statement("CREATE DATABASE IF NOT EXISTS `{$dbName}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");

                if ($this->option('fresh')) {
                    $this->warn("  → DROP + пересоздание {$dbName}");
                    DB::statement("DROP DATABASE IF EXISTS `{$dbName}`");
                    DB::statement("CREATE DATABASE `{$dbName}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
                    // Переподключаемся после DROP
                    TenantService::connect($tenant->id);
                }

                // Запускаем миграции
                Artisan::call('migrate', [
                    '--database' => $dbName,
                    '--path'     => 'database/migrations/tenant',
                    '--force'    => true,
                ]);

                $output = trim(Artisan::output());
                if ($output) {
                    foreach (explode("\n", $output) as $line) {
                        if (trim($line)) $this->line("  {$line}");
                    }
                } else {
                    $this->line("  → Nothing to migrate");
                }

                // Сидер
                if ($this->option('seed') || $this->option('fresh')) {
                    $this->line("  → Seeding...");
                    DB::setDefaultConnection($dbName);
                    (new \Database\Seeders\TenantDatabaseSeeder())->setContainer(app())->run();
                    DB::setDefaultConnection('mysql');
                    $this->line("  → Seeded OK");
                }

                $this->info("  ✓ OK");
                $success++;

            } catch (\Exception $e) {
                $this->error("  ✗ Ошибка: " . $e->getMessage());
                $failed++;
            }
        }

        $this->line('');
        $this->line("──────────────────────────────────");
        $this->info("Готово: {$success} успешно" . ($failed ? ", {$failed} с ошибками" : ''));

        return $failed > 0 ? self::FAILURE : self::SUCCESS;
    }
}
