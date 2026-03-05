<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class InfoSeeder extends Seeder
{
    public function run(): void
    {
        $now = now();
        $items = [
            // cash — Касса/Счёт
            ['name' => 'Касса',               'type' => 'cash',  'code' => 'CASH',  'parent_id' => null, 'sort_order' => 0, 'is_active' => true],
            ['name' => 'Расчётный счёт',      'type' => 'cash',  'code' => 'BANK',  'parent_id' => null, 'sort_order' => 1, 'is_active' => true],

            // flow — Статья движения (иерархия)
            ['name' => 'Операционная деятельность',           'type' => 'flow', 'code' => 'OD',  'parent_id' => null, 'sort_order' => 0, '_pk' => 'od', 'is_active' => true],
            ['name' => 'Поступление (ОД)',                    'type' => 'flow', 'code' => 'OD-IN',   'parent_id' => null, 'sort_order' => 0, '_pk' => 'od_in', '_parent' => 'od', 'is_active' => true],
            ['name' => 'Поступление денег от клиентов (ДДС)', 'type' => 'flow', 'code' => 'OD-IN-CUST','parent_id' => null, 'sort_order' => 0, '_pk' => 'od_in_cust', '_parent' => 'od_in', 'is_active' => true],
            ['name' => 'Прочее поступление (ДДС)',            'type' => 'flow', 'code' => 'OD-IN-OTH','parent_id' => null, 'sort_order' => 1, '_pk' => 'od_in_oth', '_parent' => 'od_in', 'is_active' => true],
            ['name' => 'Списание (ОД)',                       'type' => 'flow', 'code' => 'OD-OUT',  'parent_id' => null, 'sort_order' => 1, '_pk' => 'od_out', '_parent' => 'od', 'is_active' => true],
            ['name' => 'Переменные расходы (ДДС)',            'type' => 'flow', 'code' => 'OD-OUT-VAR','parent_id' => null, 'sort_order' => 0, '_pk' => 'od_out_var', '_parent' => 'od_out', 'is_active' => true],
            ['name' => 'Закупка материалов и услуг (ДДС)',    'type' => 'flow', 'code' => 'OD-OUT-MAT','parent_id' => null, 'sort_order' => 0, '_pk' => 'od_out_mat', '_parent' => 'od_out_var', 'is_active' => true],
            ['name' => 'Оборотные налоги (ДДС)',              'type' => 'flow', 'code' => 'OD-OUT-TAX','parent_id' => null, 'sort_order' => 1, '_pk' => 'od_out_tax', '_parent' => 'od_out_var', 'is_active' => true],
            ['name' => 'Постоянные расходы (ДДС)',            'type' => 'flow', 'code' => 'OD-OUT-FIX','parent_id' => null, 'sort_order' => 1, '_pk' => 'od_out_fix', '_parent' => 'od_out', 'is_active' => true],
            ['name' => 'ЗП и налоги (ДДС)',                   'type' => 'flow', 'code' => 'OD-OUT-ZP','parent_id' => null, 'sort_order' => 0, '_pk' => 'od_out_zp', '_parent' => 'od_out_fix', 'is_active' => true],
            ['name' => 'Аренда помещений (ДДС)',              'type' => 'flow', 'code' => 'OD-OUT-RNT','parent_id' => null, 'sort_order' => 1, '_pk' => 'od_out_rnt', '_parent' => 'od_out_fix', 'is_active' => true],
            ['name' => 'Административные расходы (ДДС)',      'type' => 'flow', 'code' => 'OD-OUT-ADM','parent_id' => null, 'sort_order' => 2, '_pk' => 'od_out_adm', '_parent' => 'od_out_fix', 'is_active' => true],
            ['name' => 'Коммерческие расходы (ДДС)',          'type' => 'flow', 'code' => 'OD-OUT-COM','parent_id' => null, 'sort_order' => 3, '_pk' => 'od_out_com', '_parent' => 'od_out_fix', 'is_active' => true],
            ['name' => 'Производственные расходы (ДДС)',      'type' => 'flow', 'code' => 'OD-OUT-PRD','parent_id' => null, 'sort_order' => 4, '_pk' => 'od_out_prd', '_parent' => 'od_out_fix', 'is_active' => true],
            ['name' => 'Перемещение (ОД)',                    'type' => 'flow', 'code' => 'OD-TRF',   'parent_id' => null, 'sort_order' => 2, '_pk' => 'od_trf', '_parent' => 'od', 'is_active' => true],
            ['name' => 'Перемещение денег (ДДС)',             'type' => 'flow', 'code' => 'OD-TRF-MNY','parent_id' => null, 'sort_order' => 0, '_pk' => 'od_trf_mny', '_parent' => 'od_trf', 'is_active' => true],

            // product — Товар/Услуга
            ['name' => 'Основная продукция',  'type' => 'product',  'code' => 'PROD', 'parent_id' => null, 'sort_order' => 0, 'is_active' => true],
            ['name' => 'Услуга',              'type' => 'product',  'code' => 'SVC',  'parent_id' => null, 'sort_order' => 1, 'is_active' => true],

            // department — Отдел
            ['name' => 'Основной отдел',      'type' => 'department', 'code' => 'MAIN', 'parent_id' => null, 'sort_order' => 0, 'is_active' => true],

            // partner — Контрагент
            ['name' => 'Без контрагента',     'type' => 'partner', 'code' => 'NONE', 'parent_id' => null, 'sort_order' => 0, 'is_active' => true],

            // employee — Сотрудник
            ['name' => 'Не указан',           'type' => 'employee', 'code' => 'NONE', 'parent_id' => null, 'sort_order' => 0, 'is_active' => true],

            // revenue — Статья дохода
            ['name' => 'Выручка от продаж',   'type' => 'revenue', 'code' => 'SALES', 'parent_id' => null, 'sort_order' => 0, 'is_active' => true],
            ['name' => 'Прочие доходы',       'type' => 'revenue', 'code' => 'OTHER', 'parent_id' => null, 'sort_order' => 1, 'is_active' => true],

            // expenses — Статья расхода
            ['name' => 'Закупки',             'type' => 'expenses', 'code' => 'PURCH', 'parent_id' => null, 'sort_order' => 0, 'is_active' => true],
            ['name' => 'Оплата труда',        'type' => 'expenses', 'code' => 'SALARY','parent_id' => null, 'sort_order' => 1, 'is_active' => true],
            ['name' => 'Прочие расходы',      'type' => 'expenses', 'code' => 'OTHER', 'parent_id' => null, 'sort_order' => 2, 'is_active' => true],
        ];

        // idMap: _pk (строка) => id в БД. Заполняется по мере вставки.
        $idMap = [];
        foreach ($items as $item) {
            $pk = $item['_pk'] ?? null;
            $parentKey = $item['_parent'] ?? null;
            unset($item['_pk'], $item['_parent']);
            $item['description'] = null;
            $item['sort_order'] = $item['sort_order'] ?? 0;
            $item['created_at'] = $now;
            $item['updated_at'] = $now;

            // Подставляем id родителя: _parent указывает на _pk родителя
            if ($parentKey !== null && isset($idMap[$parentKey])) {
                $item['parent_id'] = $idMap[$parentKey];
            }

            $id = DB::table('info')->insertGetId($item);
            if ($pk !== null) {
                $idMap[$pk] = $id;
            }
        }
    }
}
