<?php

namespace App\Services;

/**
 * Каталог системных счетов.
 *
 * Раньше все счета создавались разом при регистрации, и дальше список не жил:
 * доставить новый счёт в существующую базу было нечем, а удалить лишний —
 * нельзя. В итоге у каждого тенанта висели «Авансы покупателей» и «Займы
 * выданные», которыми никто не пользовался.
 *
 * Теперь это каталог: часть счетов заводится сразу (`default`), остальные
 * добавляются кнопкой, когда понадобятся, и удаляются, когда оказались лишними.
 * Список один на сидер и на интерфейс — иначе они разъедутся.
 *
 * Идентификаторы фиксированы: одинаковые у всех тенантов, свои счета тенанта
 * начинаются с 990 и в этот диапазон не заходят.
 */
class ChartOfAccounts
{
    public const ASSETS      = 'assets';
    public const LIABILITIES = 'liabilities';
    public const CAPITAL     = 'capital';
    public const PROFIT      = 'profit';

    public static function groups(): array
    {
        return [
            self::ASSETS      => 'Активы',
            self::LIABILITIES => 'Пассивы',
            self::CAPITAL     => 'Капитал',
            self::PROFIT      => 'Прибыль',
        ];
    }

    /**
     * Весь каталог. `default` — создаётся при регистрации, `hint` — зачем счёт
     * нужен: человек выбирает из списка кодов, и без пояснения не разобраться.
     */
    public static function all(): array
    {
        return [
            // ── Активы ────────────────────────────────────────────────────
            [
                'id' => 100, 'code' => 'А100', 'name' => 'ДЕНЕЖНЫЕ СРЕДСТВА',
                'group' => self::ASSETS, 'default' => true,
                'info_1_type' => 'cash', 'info_2_type' => 'flow', 'has_quantity' => 0,
                'hint' => 'Кассы и расчётные счета. Через него проходят все деньги.',
            ],
            [
                'id' => 110, 'code' => 'А110', 'name' => 'ДЕНЬГИ В ПУТИ',
                'group' => self::ASSETS, 'default' => false,
                'info_1_type' => 'cash', 'info_2_type' => 'flow', 'has_quantity' => 0,
                'hint' => 'Эквайринг и инкассация: выручка пробита, а на счёт ещё не пришла.',
            ],
            [
                'id' => 200, 'code' => 'А200', 'name' => 'ТОВАРЫ',
                'group' => self::ASSETS, 'default' => true,
                'info_1_type' => 'product', 'info_2_type' => 'department', 'has_quantity' => 1,
                'hint' => 'Товар на складе, с количественным учётом.',
            ],
            [
                'id' => 230, 'code' => 'А230', 'name' => 'МАТЕРИАЛЫ ДЛЯ ПРОИЗВОДСТВА',
                'group' => self::ASSETS, 'default' => false,
                'info_1_type' => 'product', 'info_2_type' => null, 'has_quantity' => 1,
                'hint' => 'Сырьё и материалы, если ведёте производство отдельно от товаров.',
            ],
            [
                'id' => 240, 'code' => 'А240', 'name' => 'ПРОДУКТЫ',
                'group' => self::ASSETS, 'default' => false,
                'info_1_type' => 'product', 'info_2_type' => null, 'has_quantity' => 1,
                'hint' => 'Готовая продукция кухни или производства.',
            ],
            [
                'id' => 250, 'code' => 'А250', 'name' => 'МАТЕРИАЛЫ ДЛЯ ХОЗРАСХОДОВ',
                'group' => self::ASSETS, 'default' => false,
                'info_1_type' => 'product', 'info_2_type' => null, 'has_quantity' => 1,
                'hint' => 'Моющие средства, одноразовая посуда, канцелярия — то, что расходуется, но не входит в себестоимость.',
            ],
            [
                'id' => 300, 'code' => 'А300', 'name' => 'КЛИЕНТЫ',
                'group' => self::ASSETS, 'default' => true,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Долг покупателей: отгрузили, денег ещё не получили.',
            ],
            [
                'id' => 410, 'code' => 'А410', 'name' => 'АВАНСЫ ПОСТАВЩИКАМ',
                'group' => self::ASSETS, 'default' => false,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Заплатили вперёд, товар или услугу ещё не получили.',
            ],
            [
                'id' => 430, 'code' => 'А430', 'name' => 'ЗАЙМЫ ВЫДАННЫЕ',
                'group' => self::ASSETS, 'default' => false,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Деньги, которые вы дали в долг.',
            ],
            [
                'id' => 500, 'code' => 'А500', 'name' => 'ОСНОВНЫЕ СРЕДСТВА',
                'group' => self::ASSETS, 'default' => false,
                'info_1_type' => 'product', 'info_2_type' => 'department', 'has_quantity' => 0,
                'hint' => 'Оборудование, техника, ремонт — то, что куплено надолго.',
            ],

            // ── Пассивы ───────────────────────────────────────────────────
            [
                'id' => 600, 'code' => 'П100', 'name' => 'ПОСТАВЩИКИ',
                'group' => self::LIABILITIES, 'default' => true,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Долг перед поставщиками: получили, ещё не заплатили.',
            ],
            [
                'id' => 610, 'code' => 'П110', 'name' => 'ПОСТАВЩИКИ ПРЯМЫХ РАСХОДОВ',
                'group' => self::LIABILITIES, 'default' => false,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Отдельно от П100, если делите поставщиков на прямых и косвенных.',
            ],
            [
                'id' => 650, 'code' => 'П150', 'name' => 'ПОСТАВЩИКИ КОСВЕННЫХ РАСХОДОВ',
                'group' => self::LIABILITIES, 'default' => false,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Аренда, связь, услуги — то, что не входит в себестоимость.',
            ],
            [
                'id' => 660, 'code' => 'П300', 'name' => 'КРЕДИТОРЫ ПРОЧИЕ',
                'group' => self::LIABILITIES, 'default' => false,
                'info_1_type' => null, 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Долги, не попавшие в остальные счета.',
            ],
            [
                'id' => 670, 'code' => 'П310', 'name' => 'АВАНСЫ ПОКУПАТЕЛЕЙ',
                'group' => self::LIABILITIES, 'default' => false,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Клиент заплатил вперёд, вы ещё не отгрузили.',
            ],
            [
                'id' => 680, 'code' => 'П320', 'name' => 'ЗАЙМЫ ПОЛУЧЕННЫЕ',
                'group' => self::LIABILITIES, 'default' => false,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Деньги, взятые в долг у людей и компаний.',
            ],
            [
                'id' => 690, 'code' => 'П360', 'name' => 'КРЕДИТЫ БАНКОВ',
                'group' => self::LIABILITIES, 'default' => false,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Банковские кредиты, овердрафт, лизинг — отдельно от частных займов.',
            ],
            [
                'id' => 700, 'code' => 'П335', 'name' => 'СОТРУДНИКИ',
                'group' => self::LIABILITIES, 'default' => true,
                'info_1_type' => 'employee', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Расчёты с сотрудниками: начислено, но не выплачено.',
            ],
            [
                'id' => 800, 'code' => 'П340', 'name' => 'ГОСУДАРСТВО',
                'group' => self::LIABILITIES, 'default' => true,
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Налоги и взносы: начислены и ждут уплаты.',
            ],

            // ── Капитал ───────────────────────────────────────────────────
            [
                'id' => 900, 'code' => 'П500', 'name' => 'КАПИТАЛ',
                'group' => self::CAPITAL, 'default' => true,
                'info_1_type' => null, 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Группа для трёх счетов капитала ниже.',
            ],
            [
                'id' => 905, 'code' => 'П505', 'name' => 'ИНВЕСТИЦИОННЫЙ КАПИТАЛ',
                'group' => self::CAPITAL, 'default' => true, 'parent_code' => 'П500',
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Вложения собственников в бизнес.',
            ],
            [
                'id' => 950, 'code' => 'П550', 'name' => 'ОПЕРАЦИОННЫЙ КАПИТАЛ',
                'group' => self::CAPITAL, 'default' => true, 'parent_code' => 'П500',
                'info_1_type' => 'revenue', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Заработанное и оставшееся в деле.',
            ],
            [
                'id' => 955, 'code' => 'П555', 'name' => 'ВЫВЕДЕННЫЙ КАПИТАЛ',
                'group' => self::CAPITAL, 'default' => true, 'parent_code' => 'П500',
                'info_1_type' => 'partner', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Дивиденды и изъятия собственников.',
            ],

            // ── Прибыль ───────────────────────────────────────────────────
            [
                'id' => 985, 'code' => 'П585', 'name' => 'ТЕКУЩАЯ ЧИСТАЯ ПРИБЫЛЬ',
                'group' => self::PROFIT, 'default' => true,
                'info_1_type' => null, 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Группа для доходов, себестоимости и расходов.',
            ],
            [
                'id' => 987, 'code' => 'П587', 'name' => 'ДОХОДЫ',
                'group' => self::PROFIT, 'default' => true, 'parent_code' => 'П585',
                'info_1_type' => 'revenue', 'info_2_type' => 'product', 'has_quantity' => 0,
                'hint' => 'Выручка по статьям доходов. Из него строится БДР.',
            ],
            [
                'id' => 988, 'code' => 'П588', 'name' => 'СЕБЕСТОИМОСТЬ',
                'group' => self::PROFIT, 'default' => true, 'parent_code' => 'П585',
                'info_1_type' => 'revenue', 'info_2_type' => 'product', 'has_quantity' => 0,
                'hint' => 'Прямые расходы на то, что продали.',
            ],
            [
                'id' => 989, 'code' => 'П589', 'name' => 'РАСХОДЫ',
                'group' => self::PROFIT, 'default' => true, 'parent_code' => 'П585',
                'info_1_type' => 'expenses', 'info_2_type' => null, 'has_quantity' => 0,
                'hint' => 'Расходы по статьям: аренда, зарплата, реклама.',
            ],
        ];
    }

    /** Счета, которые получает новый тенант */
    public static function defaults(): array
    {
        return array_values(array_filter(self::all(), fn($a) => $a['default']));
    }

    public static function byCode(string $code): ?array
    {
        foreach (self::all() as $account) {
            if ($account['code'] === $code) return $account;
        }
        return null;
    }

    /**
     * Строка каталога → строка таблицы balance_items.
     *
     * `parent_id` разрешается по коду родителя: в каталоге он записан кодом,
     * потому что id может оказаться занят и тогда родитель ляжет с другим.
     */
    public static function toRow(array $account, array $idsByCode = []): array
    {
        return [
            'parent_id'    => isset($account['parent_code']) ? ($idsByCode[$account['parent_code']] ?? null) : null,
            'name'         => $account['name'],
            'code'         => $account['code'],
            'info_1_type'  => $account['info_1_type'] ?? null,
            'info_2_type'  => $account['info_2_type'] ?? null,
            'info_3_type'  => $account['info_3_type'] ?? null,
            'is_system'    => 1,
            'has_quantity' => $account['has_quantity'] ?? 0,
        ];
    }
}
