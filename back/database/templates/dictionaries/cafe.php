<?php

/**
 * Шаблон справочников: общепит (кофейня, кафе, бар).
 *
 * Пример шаблона под бизнес-модель. Наследует базовый набор (`extends`) и
 * добавляет к нему отраслевую специфику: выручка по точкам продаж, продукты
 * и сырьё, эквайринг, коммуналка.
 *
 * `parent` и `default_expense` могут ссылаться на key из родительского шаблона —
 * дерево ДДС продолжается, а не дублируется.
 */

return [
    'extends'     => 'basic',
    'name'        => 'Общепит (кофейня, кафе, бар)',
    'description' => 'Базовый набор плюс отраслевое: выручка бара и кухни, продукты и сырьё, эквайринг, коммунальные платежи, реклама. Пример шаблона под бизнес-модель — правьте под себя.',

    'items' => [
        // ── Статьи доходов ───────────────────────────────────────────────────
        ['type' => 'revenue', 'name' => 'Выручка бара',    'code' => 'REV-BAR'],
        ['type' => 'revenue', 'name' => 'Выручка кухни',   'code' => 'REV-KIT'],
        ['type' => 'revenue', 'name' => 'Доставка и навынос', 'code' => 'REV-DLV'],

        // ── Статьи расходов ──────────────────────────────────────────────────
        ['type' => 'expenses', 'name' => 'Продукты и сырьё',              'code' => 'EX-FOOD', 'key' => 'ex_food'],
        ['type' => 'expenses', 'name' => 'Коммунальные услуги',           'code' => 'EX-UTIL', 'key' => 'ex_util'],
        ['type' => 'expenses', 'name' => 'Эквайринг и комиссии банка',    'code' => 'EX-ACQ',  'key' => 'ex_acq'],
        ['type' => 'expenses', 'name' => 'Реклама и маркетинг',           'code' => 'EX-MKT',  'key' => 'ex_mkt'],
        ['type' => 'expenses', 'name' => 'Хозяйственные расходы',         'code' => 'EX-HOZ',  'key' => 'ex_hoz'],

        // ── Статьи ДДС — продолжают дерево базового шаблона ───────────────────
        ['type' => 'flow', 'name' => 'Закупка продуктов и сырья (ДДС)', 'code' => 'OD-OUT-FOOD', 'parent' => 'od_out_var', 'default_expense' => 'ex_food'],
        ['type' => 'flow', 'name' => 'Коммунальные платежи (ДДС)',      'code' => 'OD-OUT-UTIL', 'parent' => 'od_out_fix', 'default_expense' => 'ex_util'],
        ['type' => 'flow', 'name' => 'Эквайринг и комиссии банка (ДДС)', 'code' => 'OD-OUT-ACQ', 'parent' => 'od_out_fix', 'default_expense' => 'ex_acq'],
        ['type' => 'flow', 'name' => 'Реклама и маркетинг (ДДС)',       'code' => 'OD-OUT-MKT',  'parent' => 'od_out_fix', 'default_expense' => 'ex_mkt'],
        ['type' => 'flow', 'name' => 'Хозяйственные расходы (ДДС)',     'code' => 'OD-OUT-HOZ',  'parent' => 'od_out_fix', 'default_expense' => 'ex_hoz'],

        // ── Товары и точки продаж ────────────────────────────────────────────
        ['type' => 'product', 'name' => 'Кофе и напитки', 'code' => 'PR-COF'],
        ['type' => 'product', 'name' => 'Выпечка',        'code' => 'PR-BAK'],
        ['type' => 'product', 'name' => 'Кухня',          'code' => 'PR-KIT'],

        ['type' => 'department', 'name' => 'Бар',   'code' => 'DEP-BAR'],
        ['type' => 'department', 'name' => 'Кухня', 'code' => 'DEP-KIT'],
        ['type' => 'department', 'name' => 'Зал',   'code' => 'DEP-HALL'],
    ],
];
