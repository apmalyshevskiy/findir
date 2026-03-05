<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class BalanceItemsSeeder extends Seeder
{
    public function run(): void
    {
        $items = [
            // АКТИВЫ
            ['id' => 100,  'parent_id' => null, 'name' => 'А100 ДЕНЕЖНЫЕ СРЕДСТВА',          'code' => 'А100', 'info_1_type' => 'cash',     'info_2_type' => 'flow',    'info_3_type' => null,   'is_system' => 1],
            ['id' => 200,  'parent_id' => null, 'name' => 'А200 ТОВАРЫ',                     'code' => 'А200', 'info_1_type' => 'product',  'info_2_type' => 'department', 'info_3_type' => null, 'is_system' => 1],
            ['id' => 230,  'parent_id' => null, 'name' => 'А230 МАТЕРИАЛЫ ДЛЯ ПРОИЗВОДСТВА', 'code' => 'А230', 'info_1_type' => 'product',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 240,  'parent_id' => null, 'name' => 'А240 ПРОДУКТЫ',                   'code' => 'А240', 'info_1_type' => 'product',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 300,  'parent_id' => null, 'name' => 'А405 КЛИЕНТЫ',                    'code' => 'А405', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 410,  'parent_id' => null, 'name' => 'А410 АВАНСЫ ПОСТАВЩИКАМ',         'code' => 'А410', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 430,  'parent_id' => null, 'name' => 'А430 ЗАЙМЫ ВЫДАННЫЕ',             'code' => 'А430', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            // ПАССИВЫ
            ['id' => 600,  'parent_id' => null, 'name' => 'П100 ПОСТАВЩИКИ',                 'code' => 'П100', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 610,  'parent_id' => null, 'name' => 'П110 ПОСТАВЩИКИ ПРЯМЫХ РАСХОДОВ', 'code' => 'П110', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 650,  'parent_id' => null, 'name' => 'П150 ПОСТАВЩИКИ КОСВЕННЫХ РАСХОДОВ', 'code' => 'П150', 'info_1_type' => 'partner', 'info_2_type' => null,   'info_3_type' => null,   'is_system' => 1],
            ['id' => 660,  'parent_id' => null, 'name' => 'П300 КРЕДИТОРЫ ПРОЧИЕ',           'code' => 'П300', 'info_1_type' => null,       'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 670,  'parent_id' => null, 'name' => 'П310 АВАНСЫ ПОКУПАТЕЛЕЙ',         'code' => 'П310', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 680,  'parent_id' => null, 'name' => 'П320 ЗАЙМЫ ПОЛУЧЕННЫЕ',           'code' => 'П320', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 700,  'parent_id' => null, 'name' => 'П335 СОТРУДНИКИ',                 'code' => 'П335', 'info_1_type' => 'employee', 'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 800,  'parent_id' => null, 'name' => 'П340 ГОСУДАРСТВО',                'code' => 'П340', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            // КАПИТАЛ
            ['id' => 890,  'parent_id' => null, 'name' => 'П500 КАПИТАЛ',                    'code' => 'П500', 'info_1_type' => null,       'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 900,  'parent_id' => 890,  'name' => 'П505 ИНВЕСТИЦИОННЫЙ КАПИТАЛ',     'code' => 'П505', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 910,  'parent_id' => 890,  'name' => 'П550 ОПЕРАЦИОННЫЙ КАПИТАЛ',       'code' => 'П550', 'info_1_type' => 'revenue',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 912,  'parent_id' => 890,  'name' => 'П555 ВЫВЕДЕННЫЙ КАПИТАЛ',         'code' => 'П555', 'info_1_type' => 'partner',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            // ПРИБЫЛЬ
            ['id' => 917,  'parent_id' => null, 'name' => 'П585 ТЕКУЩАЯ ЧИСТАЯ ПРИБЫЛЬ',    'code' => 'П585', 'info_1_type' => null,       'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 913,  'parent_id' => 917,  'name' => 'П587 ДОХОДЫ',                    'code' => 'П587', 'info_1_type' => 'revenue',  'info_2_type' => 'product',  'info_3_type' => null,   'is_system' => 1],
            ['id' => 914,  'parent_id' => 917,  'name' => 'П588 СЕБЕСТОИМОСТЬ',             'code' => 'П588', 'info_1_type' => 'product',  'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
            ['id' => 915,  'parent_id' => 917,  'name' => 'П589 РАСХОДЫ',                   'code' => 'П589', 'info_1_type' => 'expenses', 'info_2_type' => null,      'info_3_type' => null,   'is_system' => 1],
        ];

        $now = now();
        foreach ($items as &$item) {
            $item['created_at'] = $now;
            $item['updated_at'] = $now;
        }

        DB::table('balance_items')->insertOrIgnore($items);
    }
}
