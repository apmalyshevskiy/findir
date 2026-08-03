<?php

namespace Database\Seeders;

use App\Services\DictionaryTemplates;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Наполнение справочников базовым шаблоном.
 *
 * При регистрации НЕ вызывается — тенант стартует с пустыми справочниками и
 * наполняет их сам (кнопка «Заполнить» в разделе «Справочники»). Сидер оставлен
 * для ручного засева существующих баз:
 *
 *     php artisan db:seed --database=findir_kofe --class=InfoSeeder
 *
 * Само наполнение живёт в database/templates/dictionaries/basic.php —
 * один источник правды для сидера и для кнопки.
 */
class InfoSeeder extends Seeder
{
    public function run(): void
    {
        // Во время сидинга тенанта дефолтное соединение указывает на его БД
        DictionaryTemplates::apply('basic', DB::getDefaultConnection());
    }
}
