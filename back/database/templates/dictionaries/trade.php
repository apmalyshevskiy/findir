<?php

/**
 * Шаблон справочников: оптовая торговля.
 *
 * Самостоятельный, базовый не наследует: у торговли своё дерево ДДС и своя
 * логика расходов, и слияние с универсальным набором дало бы две статьи
 * «Поступление» о разном.
 *
 * Два решения, из которых всё остальное следует.
 *
 * **Вид расхода** проставлен у каждой статьи, а не оставлен на потом. У
 * оптовика переменных расходов немного, но они настоящие: доставка, упаковка и
 * бонусы менеджерам растут строго вместе с оборотом, а аренда склада и ФОТ
 * администрации не шевелятся. Без этой разметки БДР покажет одну кучу расходов
 * и не ответит на главный вопрос торговли — сколько остаётся с рубля продаж.
 *
 * **Инвестиции отдельным видом**: ремонт склада и внедрение ПО не должны
 * занижать операционную прибыль месяца, в котором их сделали.
 *
 * Статьи ДДС размечены видом деятельности, поэтому ОДДС читается сразу: кредит
 * и дивиденды в финансовом разделе, покупка оборудования в инвестиционном,
 * и месяц с крупной закупкой техники не выглядит провальным.
 */

return [
    'name'        => 'Оптовая торговля',
    'description' => 'Опт и дистрибуция: выручка по каналам сбыта, расходы с делением на переменные, постоянные и инвестиционные, дерево ДДС по трём видам деятельности. Подходит компаниям, которые закупают и перепродают.',

    'items' => [
        // ── Кассы и счета ────────────────────────────────────────────────────
        ['type' => 'cash', 'name' => 'Расчётный счёт (основной)',  'code' => 'BANK-A'],
        ['type' => 'cash', 'name' => 'Расчётный счёт (резервный)', 'code' => 'BANK-B'],
        ['type' => 'cash', 'name' => 'Касса',                      'code' => 'CASH'],

        // ── Статьи доходов: каналы сбыта ─────────────────────────────────────
        // Разрез по каналу, а не по товару: маржа в опте различается прежде
        // всего условиями канала, а товарная аналитика живёт в операционной базе
        ['type' => 'revenue', 'name' => 'Опт — торговые сети', 'code' => 'SALES-CHAIN'],
        ['type' => 'revenue', 'name' => 'Опт — регионы',       'code' => 'SALES-REG'],
        ['type' => 'revenue', 'name' => 'Прочая реализация',   'code' => 'SALES-OTH'],

        // ── Статьи расходов ──────────────────────────────────────────────────
        // Идут до статей ДДС: на них ссылается default_expense.

        ['type' => 'expenses', 'name' => 'Логистика и склад', 'code' => '10', 'key' => 'ex_log', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Доставка покупателям',           'code' => '1010', 'key' => 'ex_deliv', 'parent' => 'ex_log', 'expense_kind' => 'variable'],
        ['type' => 'expenses', 'name' => 'Входящая логистика',             'code' => '1020', 'key' => 'ex_inlog', 'parent' => 'ex_log', 'expense_kind' => 'variable'],
        ['type' => 'expenses', 'name' => 'Упаковка и расходные материалы', 'code' => '1030', 'key' => 'ex_pack',  'parent' => 'ex_log', 'expense_kind' => 'variable'],
        ['type' => 'expenses', 'name' => 'Аренда склада',                  'code' => '1040', 'key' => 'ex_whrent','parent' => 'ex_log', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'ФОТ склада',                     'code' => '1050', 'key' => 'ex_whzp',  'parent' => 'ex_log', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Обслуживание склада и техники',  'code' => '1060', 'key' => 'ex_whsvc', 'parent' => 'ex_log', 'expense_kind' => 'fixed'],

        ['type' => 'expenses', 'name' => 'Коммерческие расходы', 'code' => '20', 'key' => 'ex_com', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'ФОТ отдела продаж',               'code' => '2010', 'key' => 'ex_salezp', 'parent' => 'ex_com', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Бонусы с продаж',                 'code' => '2020', 'key' => 'ex_bonus',  'parent' => 'ex_com', 'expense_kind' => 'variable'],
        ['type' => 'expenses', 'name' => 'Реклама и продвижение',           'code' => '2030', 'key' => 'ex_adv',    'parent' => 'ex_com', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Представительские и командировки','code' => '2040', 'key' => 'ex_trip',   'parent' => 'ex_com', 'expense_kind' => 'fixed'],

        ['type' => 'expenses', 'name' => 'Административные расходы', 'code' => '30', 'key' => 'ex_adm', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'ФОТ администрации',          'code' => '3010', 'key' => 'ex_admzp',  'parent' => 'ex_adm', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Аренда офиса',               'code' => '3020', 'key' => 'ex_ofrent', 'parent' => 'ex_adm', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'IT, связь и ПО',             'code' => '3030', 'key' => 'ex_it',     'parent' => 'ex_adm', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Бухгалтерия, юристы, аудит', 'code' => '3040', 'key' => 'ex_svc',    'parent' => 'ex_adm', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Хозрасходы и канцелярия',    'code' => '3050', 'key' => 'ex_hoz',    'parent' => 'ex_adm', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Банковские услуги',          'code' => '3060', 'key' => 'ex_bank',   'parent' => 'ex_adm', 'expense_kind' => 'fixed'],

        ['type' => 'expenses', 'name' => 'Налоги и взносы', 'code' => '40', 'key' => 'ex_tax', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Страховые взносы',        'code' => '4010', 'key' => 'ex_social',  'parent' => 'ex_tax', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Налог на прибыль',        'code' => '4020', 'key' => 'ex_profit',  'parent' => 'ex_tax', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Прочие налоги и сборы',   'code' => '4030', 'key' => 'ex_taxoth',  'parent' => 'ex_tax', 'expense_kind' => 'fixed'],

        ['type' => 'expenses', 'name' => 'Финансовые расходы', 'code' => '50', 'key' => 'ex_fin', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Проценты по кредитам',    'code' => '5010', 'key' => 'ex_interest', 'parent' => 'ex_fin', 'expense_kind' => 'fixed'],
        ['type' => 'expenses', 'name' => 'Факторинг и комиссии',    'code' => '5020', 'key' => 'ex_factor',   'parent' => 'ex_fin', 'expense_kind' => 'variable'],

        // Вид «инвестиционная» — у группы тоже: в неё кладут разовые траты,
        // которым не нашлось своей статьи, и попасть они должны в инвестиции
        ['type' => 'expenses', 'name' => 'Инвестиции', 'code' => '60', 'key' => 'ex_inv', 'expense_kind' => 'investment'],
        ['type' => 'expenses', 'name' => 'Оборудование и техника',      'code' => '6010', 'key' => 'ex_equip', 'parent' => 'ex_inv', 'expense_kind' => 'investment'],
        ['type' => 'expenses', 'name' => 'Ремонт и обустройство',       'code' => '6020', 'key' => 'ex_repair','parent' => 'ex_inv', 'expense_kind' => 'investment'],
        ['type' => 'expenses', 'name' => 'Внедрение ПО и автоматизация','code' => '6030', 'key' => 'ex_soft',  'parent' => 'ex_inv', 'expense_kind' => 'investment'],

        // ── Статьи движения денег ────────────────────────────────────────────

        ['type' => 'flow', 'name' => 'Операционная деятельность', 'code' => 'OD', 'key' => 'od', 'flow_kind' => 'operating'],

        ['type' => 'flow', 'name' => 'Поступления (ОД)', 'code' => 'OD-IN', 'key' => 'od_in', 'parent' => 'od', 'flow_kind' => 'operating'],
        ['type' => 'flow', 'name' => 'Оплата от покупателей', 'code' => 'OD-IN-CUST', 'key' => 'od_in_cust', 'parent' => 'od_in', 'flow_kind' => 'operating'],
        ['type' => 'flow', 'name' => 'Прочие поступления',    'code' => 'OD-IN-OTH',  'key' => 'od_in_oth',  'parent' => 'od_in', 'flow_kind' => 'operating'],

        ['type' => 'flow', 'name' => 'Выплаты (ОД)', 'code' => 'OD-OUT', 'key' => 'od_out', 'parent' => 'od', 'flow_kind' => 'operating'],
        // У оплаты товара статьи расхода нет намеренно: товар уходит на склад,
        // а в расходы попадает себестоимостью при отгрузке
        ['type' => 'flow', 'name' => 'Оплата поставщикам товара',        'code' => 'OD-OUT-GOODS', 'key' => 'od_out_goods', 'parent' => 'od_out', 'flow_kind' => 'operating'],
        ['type' => 'flow', 'name' => 'Логистика и доставка',             'code' => 'OD-OUT-LOG',   'key' => 'od_out_log',   'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_deliv'],
        ['type' => 'flow', 'name' => 'Упаковка и расходные материалы',   'code' => 'OD-OUT-PACK',  'key' => 'od_out_pack',  'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_pack'],
        ['type' => 'flow', 'name' => 'Зарплата и выплаты сотрудникам',   'code' => 'OD-OUT-ZP',    'key' => 'od_out_zp',    'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_admzp'],
        ['type' => 'flow', 'name' => 'Налоги и взносы',                  'code' => 'OD-OUT-TAX',   'key' => 'od_out_tax',   'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_social'],
        ['type' => 'flow', 'name' => 'Аренда',                           'code' => 'OD-OUT-RENT',  'key' => 'od_out_rent',  'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_ofrent'],
        ['type' => 'flow', 'name' => 'Реклама и продвижение',            'code' => 'OD-OUT-ADV',   'key' => 'od_out_adv',   'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_adv'],
        ['type' => 'flow', 'name' => 'IT, связь и ПО',                   'code' => 'OD-OUT-IT',    'key' => 'od_out_it',    'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_it'],
        ['type' => 'flow', 'name' => 'Услуги (бухгалтерия, юристы)',     'code' => 'OD-OUT-SVC',   'key' => 'od_out_svc',   'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_svc'],
        ['type' => 'flow', 'name' => 'Хозрасходы и канцелярия',          'code' => 'OD-OUT-HOZ',   'key' => 'od_out_hoz',   'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_hoz'],
        ['type' => 'flow', 'name' => 'Банковские услуги',                'code' => 'OD-OUT-BANK',  'key' => 'od_out_bank',  'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_bank'],
        ['type' => 'flow', 'name' => 'Прочие выплаты',                   'code' => 'OD-OUT-OTH',   'key' => 'od_out_oth',   'parent' => 'od_out', 'flow_kind' => 'operating', 'default_expense' => 'ex_hoz'],

        ['type' => 'flow', 'name' => 'Перемещение денег', 'code' => 'OD-TRF', 'key' => 'od_trf', 'parent' => 'od', 'flow_kind' => 'operating'],

        ['type' => 'flow', 'name' => 'Инвестиционная деятельность', 'code' => 'INV', 'key' => 'inv', 'flow_kind' => 'investing'],
        ['type' => 'flow', 'name' => 'Покупка оборудования и техники', 'code' => 'INV-EQUIP', 'key' => 'inv_equip', 'parent' => 'inv', 'flow_kind' => 'investing', 'default_expense' => 'ex_equip'],
        ['type' => 'flow', 'name' => 'Покупка и внедрение ПО',         'code' => 'INV-SOFT',  'key' => 'inv_soft',  'parent' => 'inv', 'flow_kind' => 'investing', 'default_expense' => 'ex_soft'],
        ['type' => 'flow', 'name' => 'Ремонт и обустройство',          'code' => 'INV-REP',   'key' => 'inv_rep',   'parent' => 'inv', 'flow_kind' => 'investing', 'default_expense' => 'ex_repair'],
        ['type' => 'flow', 'name' => 'Продажа имущества',              'code' => 'INV-SELL',  'key' => 'inv_sell',  'parent' => 'inv', 'flow_kind' => 'investing'],

        ['type' => 'flow', 'name' => 'Финансовая деятельность', 'code' => 'FIN', 'key' => 'fin', 'flow_kind' => 'financing'],
        ['type' => 'flow', 'name' => 'Получение кредита',    'code' => 'FIN-LOAN-IN',  'key' => 'fin_loan_in',  'parent' => 'fin', 'flow_kind' => 'financing'],
        ['type' => 'flow', 'name' => 'Погашение кредита',    'code' => 'FIN-LOAN-OUT', 'key' => 'fin_loan_out', 'parent' => 'fin', 'flow_kind' => 'financing'],
        ['type' => 'flow', 'name' => 'Проценты по кредитам', 'code' => 'FIN-INT',      'key' => 'fin_int',      'parent' => 'fin', 'flow_kind' => 'financing', 'default_expense' => 'ex_interest'],
        ['type' => 'flow', 'name' => 'Вклад собственника',   'code' => 'FIN-OWNER',    'key' => 'fin_owner',    'parent' => 'fin', 'flow_kind' => 'financing'],
        ['type' => 'flow', 'name' => 'Дивиденды',            'code' => 'FIN-DIV',      'key' => 'fin_div',      'parent' => 'fin', 'flow_kind' => 'financing'],

        // ── Номенклатура, отделы, служебные элементы ─────────────────────────
        // Одна служебная номенклатура: отгрузка ведётся в суммовом учёте, а
        // товарная детализация остаётся в операционной базе
        ['type' => 'product', 'name' => 'Товар (суммовой учёт)', 'code' => 'TOVAR'],

        ['type' => 'department', 'name' => 'Отдел продаж',       'code' => 'SALES'],
        ['type' => 'department', 'name' => 'Склад и логистика',  'code' => 'WH'],
        ['type' => 'department', 'name' => 'Администрация',      'code' => 'ADM'],

        ['type' => 'partner',  'name' => 'Без контрагента', 'code' => 'NONE'],
        ['type' => 'employee', 'name' => 'Не указан',       'code' => 'NONE'],
    ],
];
