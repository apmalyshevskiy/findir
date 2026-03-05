<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class ProjectSeeder extends Seeder
{
    public function run(): void
    {
        DB::table('projects')->insertOrIgnore([
            'id'         => 1,
            'name'       => 'Основной проект',
            'currency'   => 'RUB',
            'timezone'   => 'Europe/Moscow',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
}
