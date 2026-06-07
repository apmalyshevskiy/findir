<?php

namespace Database\Seeders;

use App\Services\Acquiring\AcquiringFeeRules;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Дефолтные правила эквайринг-свода для нового тенанта.
 *
 * Запускается при провижининге БД тенанта (tenants:migrate --seed) в контексте
 * тенантного соединения. Идемпотентно — ensureDefaults() не затирает существующее.
 *
 * Зарегистрировать вызов в вашем тенантном сидере (TenantDatabaseSeeder), например:
 *     $this->call(AcquiringFeeRulesSeeder::class);
 */
class AcquiringFeeRulesSeeder extends Seeder
{
    public function run(): void
    {
        // Во время сидинга тенанта дефолтное соединение указывает на его БД.
        AcquiringFeeRules::ensureDefaults(DB::getDefaultConnection());
    }
}
