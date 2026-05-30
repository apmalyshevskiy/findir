<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;

class TenantDatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $this->call([
            ProjectSeeder::class,
            BalanceItemsSeeder::class,
            InfoSeeder::class,
            // Карта разноски автозаполнения выписок (ступень 2 движка правил).
            // Обязательно ПОСЛЕ InfoSeeder: ищет статью ДДС по подстроке имени.
            CategoryPostingSeeder::class,
        ]);
    }
}
