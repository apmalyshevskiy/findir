<?php

/**
 * Шаблон справочников: базовый (универсальный).
 *
 * Ровно то наполнение, которое раньше засевалось при регистрации автоматически.
 * Теперь тенант применяет его сам — кнопкой «Заполнить» в разделе «Справочники».
 *
 * Формат элемента:
 *   type            — тип справочника (cash|flow|product|department|partner|employee|revenue|expenses)
 *   name            — наименование
 *   code            — код (необязательно); по паре type+code ищется уже существующая запись
 *   key             — внутренний ключ шаблона, чтобы на элемент могли сослаться другие
 *   parent          — key родителя (иерархия)
 *   default_expense — key статьи расходов (только для type=flow): связь ДДС → статья расхода
 *   sort_order      — порядок (необязательно; по умолчанию — позиция среди соседей в этом файле)
 *
 * Чтобы добавить шаблон под бизнес-модель — положите рядом ещё один файл
 * (ключ шаблона = имя файла) с такой же структурой.
 */

return [
    'name'        => 'Базовый (универсальный)',
    'description' => 'Минимальный рабочий набор: касса и счёт, дерево статей ДДС от операционной деятельности, базовые статьи доходов и расходов. Подходит любому бизнесу как отправная точка.',

    'items' => [
        // ── Кассы и счета ────────────────────────────────────────────────────
        ['type' => 'cash', 'name' => 'Касса',          'code' => 'CASH'],
        ['type' => 'cash', 'name' => 'Расчётный счёт', 'code' => 'BANK'],

        // ── Статьи доходов ───────────────────────────────────────────────────
        ['type' => 'revenue', 'name' => 'Выручка от продаж', 'code' => 'SALES'],
        ['type' => 'revenue', 'name' => 'Прочие доходы',     'code' => 'OTHER'],

        // ── Статьи расходов ──────────────────────────────────────────────────
        // Идут до статей ДДС: на них ссылается default_expense.
        ['type' => 'expenses', 'name' => 'Закупки',        'code' => 'PURCH',  'key' => 'ex_purch'],
        ['type' => 'expenses', 'name' => 'Оплата труда',   'code' => 'SALARY', 'key' => 'ex_salary'],
        ['type' => 'expenses', 'name' => 'Прочие расходы', 'code' => 'OTHER',  'key' => 'ex_other'],

        // ── Статьи движения денег (ДДС) ──────────────────────────────────────
        ['type' => 'flow', 'name' => 'Операционная деятельность', 'code' => 'OD', 'key' => 'od'],

        ['type' => 'flow', 'name' => 'Поступление (ОД)', 'code' => 'OD-IN', 'key' => 'od_in', 'parent' => 'od'],
        ['type' => 'flow', 'name' => 'Поступление денег от клиентов (ДДС)', 'code' => 'OD-IN-CUST', 'key' => 'od_in_cust', 'parent' => 'od_in'],
        ['type' => 'flow', 'name' => 'Прочее поступление (ДДС)',            'code' => 'OD-IN-OTH',  'key' => 'od_in_oth',  'parent' => 'od_in'],

        ['type' => 'flow', 'name' => 'Списание (ОД)', 'code' => 'OD-OUT', 'key' => 'od_out', 'parent' => 'od'],

        ['type' => 'flow', 'name' => 'Переменные расходы (ДДС)', 'code' => 'OD-OUT-VAR', 'key' => 'od_out_var', 'parent' => 'od_out'],
        ['type' => 'flow', 'name' => 'Закупка материалов и услуг (ДДС)', 'code' => 'OD-OUT-MAT', 'key' => 'od_out_mat', 'parent' => 'od_out_var', 'default_expense' => 'ex_purch'],
        ['type' => 'flow', 'name' => 'Оборотные налоги (ДДС)',           'code' => 'OD-OUT-TAX', 'key' => 'od_out_tax', 'parent' => 'od_out_var', 'default_expense' => 'ex_other'],

        ['type' => 'flow', 'name' => 'Постоянные расходы (ДДС)', 'code' => 'OD-OUT-FIX', 'key' => 'od_out_fix', 'parent' => 'od_out'],
        ['type' => 'flow', 'name' => 'ЗП и налоги (ДДС)',              'code' => 'OD-OUT-ZP',  'key' => 'od_out_zp',  'parent' => 'od_out_fix', 'default_expense' => 'ex_salary'],
        ['type' => 'flow', 'name' => 'Аренда помещений (ДДС)',         'code' => 'OD-OUT-RNT', 'key' => 'od_out_rnt', 'parent' => 'od_out_fix', 'default_expense' => 'ex_other'],
        ['type' => 'flow', 'name' => 'Административные расходы (ДДС)', 'code' => 'OD-OUT-ADM', 'key' => 'od_out_adm', 'parent' => 'od_out_fix', 'default_expense' => 'ex_other'],
        ['type' => 'flow', 'name' => 'Коммерческие расходы (ДДС)',     'code' => 'OD-OUT-COM', 'key' => 'od_out_com', 'parent' => 'od_out_fix', 'default_expense' => 'ex_other'],
        ['type' => 'flow', 'name' => 'Производственные расходы (ДДС)', 'code' => 'OD-OUT-PRD', 'key' => 'od_out_prd', 'parent' => 'od_out_fix', 'default_expense' => 'ex_other'],

        ['type' => 'flow', 'name' => 'Перемещение (ОД)',      'code' => 'OD-TRF',     'key' => 'od_trf',     'parent' => 'od'],
        ['type' => 'flow', 'name' => 'Перемещение денег (ДДС)', 'code' => 'OD-TRF-MNY', 'key' => 'od_trf_mny', 'parent' => 'od_trf'],

        // ── Товары/услуги, отделы, контрагенты, сотрудники ───────────────────
        ['type' => 'product', 'name' => 'Основная продукция', 'code' => 'PROD'],
        ['type' => 'product', 'name' => 'Услуга',             'code' => 'SVC'],

        ['type' => 'department', 'name' => 'Основной отдел', 'code' => 'MAIN'],

        ['type' => 'partner',  'name' => 'Без контрагента', 'code' => 'NONE'],
        ['type' => 'employee', 'name' => 'Не указан',       'code' => 'NONE'],
    ],
];
