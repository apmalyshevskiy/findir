<?php

namespace App\Console\Commands;

use App\Models\Tenant\Document;
use App\Services\ChartOfAccounts;
use App\Services\DictionaryTemplates;
use App\Services\Documents\DocumentService;
use App\Services\History\History;
use App\Services\TenantService;
use Carbon\Carbon;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Демо-база оптовой торговли: год факта, бюджеты на тот же год и платёжный
 * календарь на стык годов.
 *
 * Зачем команда, а не разовый скрипт: демо пересобирают. Поменялась структура
 * статей, захотелось другой период, испортили данные показом — всё заново одной
 * строкой, причём с теми же цифрами: генератор сидирован (`mt_srand`), поэтому
 * два запуска дают одинаковую базу.
 *
 * Три правила, на которых держится правдоподобие.
 *
 * **Долги живут задержкой платежа, а не подгонкой под цель.** У каждой
 * отгрузки свой срок оплаты, и дебиторка на конец складывается сама из того,
 * что ещё не наступило. Подгонять ДЗ к круглому числу значило бы получить
 * ровную цифру при неживой структуре по контрагентам.
 *
 * **Кредитная линия — заглушка казначейства.** Деньги считаются по дням в
 * хронологии, и когда остаток падает ниже порога, линия выбирается, когда
 * поднимается выше — гасится. Так на счёте никогда не бывает минуса, а график
 * денег выглядит как настоящий, с подбором и возвратом.
 *
 * **Суммовой учёт.** У товарного счёта отключается количественный учёт, в
 * строке отгрузки себестоимость проставляется прямо (`amount_cost`), и
 * средневзвешенный расчёт не включается — он делит на количество, которого
 * здесь нет. Номенклатура одна, служебная: детализация живёт в операционной
 * базе.
 *
 * Операции вставляются запросом, минуя модель: история правок на три тысячи
 * сгенерированных проводок — шум, в котором потом не найти настоящую правку.
 * Поэтому весь прогон идёт внутри History::silently().
 */
class SeedDemoTrading extends Command
{
    protected $signature = 'demo:trading
                            {tenant : slug тенанта, он должен быть уже создан}
                            {--wipe : снести учётные данные тенанта перед генерацией}';

    protected $description = 'Наполнить тенанта демо-данными оптовой торговли (год факта + бюджеты + платёжный календарь)';

    /** Выручка плана за год и её сезонная раскладка по месяцам, % */
    private const PLAN_YEAR_REVENUE = 300_000_000;
    private const PLAN_SHARE = [
        1 => 5.5, 2 => 6.5, 3 => 7.5,  4 => 8.5,  5 => 8.5,  6 => 9.0,
        7 => 8.5, 8 => 9.0, 9 => 9.5, 10 => 10.0, 11 => 9.5, 12 => 8.0,
    ];

    /**
     * Факт против плана по месяцам: год прожит чуть хуже, чем планировали.
     *
     * Первое полугодие отстаёт, осенью отыгрываются — так год читается как
     * история, а не как ровный недобор на один и тот же процент.
     */
    private const FACT_VS_PLAN = [
        1 => 0.92, 2 => 0.95, 3 => 0.97,  4 => 0.94,  5 => 1.00,  6 => 0.93,
        7 => 0.91, 8 => 0.97, 9 => 0.98, 10 => 1.03, 11 => 1.01, 12 => 0.96,
    ];

    /** Границы периода факта: весь 2026 год */
    private const PERIOD_FROM = '2026-01-01';
    private const PERIOD_TO   = '2026-12-31';
    private const OPENING_AT  = '2025-12-31 23:00:00';

    /** Каналы сбыта: доля в выручке и доля себестоимости в своей выручке */
    private const CHANNELS = [
        'SALES-CHAIN' => ['share' => 0.45, 'cost' => 0.800],
        'SALES-REG'   => ['share' => 0.45, 'cost' => 0.765],
        'SALES-OTH'   => ['share' => 0.10, 'cost' => 0.750],
    ];

    /**
     * Переменные расходы: доля от выручки месяца.
     * Растут вместе с оборотом — в этом и смысл их отдельного вида.
     */
    private const VARIABLE = [
        '1010' => 0.0190,   // Доставка покупателям
        '1020' => 0.0060,   // Входящая логистика
        '1030' => 0.0030,   // Упаковка
        '2020' => 0.0060,   // Бонусы с продаж
        '5020' => 0.0020,   // Факторинг и комиссии
    ];

    /** Постоянные расходы: сумма в месяц, ₽. Не зависят от оборота */
    private const FIXED = [
        '1040' => 165_000,  // Аренда склада
        '1050' => 310_000,  // ФОТ склада
        '1060' =>  28_000,  // Обслуживание склада и техники
        '2010' => 290_000,  // ФОТ отдела продаж
        '2030' => 114_000,  // Реклама и продвижение
        '2040' =>  33_000,  // Представительские и командировки
        '3010' => 145_000,  // ФОТ администрации
        '3020' =>  75_000,  // Аренда офиса
        '3030' =>  56_000,  // IT, связь и ПО
        '3040' =>  71_000,  // Бухгалтерия, юристы, аудит
        '3050' =>  43_000,  // Хозрасходы и канцелярия
        '3060' =>  33_000,  // Банковские услуги
        '4030' =>  20_000,  // Прочие налоги и сборы
        '5010' => 290_000,  // Проценты по кредитам
    ];

    /** Статьи ФОТ: начисляются сотрудникам, а не поставщикам */
    private const PAYROLL = ['1050', '2010', '3010'];

    /** Платится сразу с расчётного счёта, без кредиторки */
    private const DIRECT_PAY = ['3060', '5010', '5020'];

    /** Отдел, на который ложится статья расхода (по первой цифре кода) */
    private const DEPT_BY_GROUP = ['1' => 'WH', '2' => 'SALES', '3' => 'ADM', '4' => 'ADM', '5' => 'ADM', '6' => 'ADM'];

    /** Статья ДДС, которой платится статья расхода */
    private const FLOW_BY_EXPENSE = [
        '1010' => 'OD-OUT-LOG',  '1020' => 'OD-OUT-LOG',  '1030' => 'OD-OUT-PACK',
        '1040' => 'OD-OUT-RENT', '1050' => 'OD-OUT-ZP',   '1060' => 'OD-OUT-HOZ',
        '2010' => 'OD-OUT-ZP',   '2020' => 'OD-OUT-ZP',   '2030' => 'OD-OUT-ADV',
        '2040' => 'OD-OUT-OTH',  '3010' => 'OD-OUT-ZP',   '3020' => 'OD-OUT-RENT',
        '3030' => 'OD-OUT-IT',   '3040' => 'OD-OUT-SVC',  '3050' => 'OD-OUT-HOZ',
        '3060' => 'OD-OUT-BANK', '4010' => 'OD-OUT-TAX',  '4020' => 'OD-OUT-TAX',
        '4030' => 'OD-OUT-TAX',  '5010' => 'FIN-INT',     '5020' => 'OD-OUT-BANK',
        '6010' => 'INV-EQUIP',   '6020' => 'INV-REP',     '6030' => 'INV-SOFT',
    ];

    /**
     * Статьи ДДС, по которым деньги приходят. Остальные — выплаты.
     *
     * Направление в ДДС знает статья, а не таблица: план хранится со знаком,
     * ровно как факт по кассе, иначе «движение за период» сложило бы
     * поступления с выплатами в одну сторону.
     */
    private const INFLOW = ['OD-IN-CUST', 'OD-IN-OTH', 'INV-SELL', 'FIN-LOAN-IN', 'FIN-OWNER'];

    /** Окна платёжного календаря: название, период, статус */
    private const PDC_WINDOWS = [
        ['Платёжный календарь — декабрь 2026', '2026-12-01', '2026-12-31', 'approved'],
        ['Платёжный календарь — январь 2027', '2027-01-01', '2027-01-31', 'draft'],
    ];

    /** Рост выручки на следующий год: январь 2027 планируется уже от него */
    private const NEXT_YEAR_GROWTH = 1.12;

    /**
     * Платежи по кредитной линии, которые казначейство ставит в календарь само.
     *
     * Линия выбрана, и банк ждёт погашения транша в середине января — а январь
     * у торговли самый слабый месяц. Платёж оставлен в плане непокрытым
     * намеренно: ровно для этого календарь и ведут, и красная строка «остаток на
     * конец» здесь не испорченные данные, а то, что финансовый директор должен
     * увидеть за месяц до события.
     */
    private const PDC_CREDIT = [
        ['2027-01-29', 'FIN-LOAN-OUT', 12_000_000, 'Погашение транша кредитной линии по графику банка'],
    ];

    /** Разовые инвестиции плана по месяцам календаря */
    private const PDC_INVEST = [
        '2026-12' => [20, 'INV-SOFT',  160_000, 'Доработка учётной системы'],
        '2027-01' => [26, 'INV-EQUIP', 120_000, 'Стеллажи и погрузочная техника'],
    ];

    private const SOCIAL_RATE = 0.301;   // страховые взносы с ФОТ
    private const PROFIT_TAX  = 0.20;    // налог на прибыль
    private const CASH_FLOOR  =  4_000_000;
    private const CASH_CEIL   = 15_000_000;
    private const OPENING_DEBT = 16_000_000;   // выбранная кредитная линия на начало года

    private string $db;
    private int $projectId;
    private int $userId;

    /** code → id */
    private array $acc = [];
    /** "type|code" → id */
    private array $info = [];

    private array $buyers = [];     // [id => название]
    private array $vendors = [];    // поставщики товара
    private array $services = [];   // поставщики услуг
    private array $staff = [];      // [id => ['name','dept','salary']]
    private int $owner;
    private int $taxman;
    private int $banker;

    /** Накопленные операции до записи: сначала строим, потом считаем деньги */
    private array $ops = [];

    /**
     * Долги: ['partner','sum','left','due'].
     *
     * `sum` — счёт целиком и он не меняется, `left` — сколько по нему осталось.
     * Платёжный календарь планирует счёт по его сроку, а не остаток после
     * оплаты: на момент составления календаря оплаты ещё не было.
     */
    private array $receivable = [];
    private array $payable = [];

    /** Итоги для расчёта налога на прибыль, по кварталам */
    private array $pnl = [];

    public function handle(): int
    {
        $tenant = (string) $this->argument('tenant');

        if (!DB::table('tenants')->where('id', $tenant)->exists()) {
            $this->error("Тенанта «{$tenant}» нет. Сначала зарегистрируйте компанию.");
            return self::FAILURE;
        }

        $this->db = TenantService::connect($tenant);
        mt_srand(20260408);

        if ($this->option('wipe')) $this->wipe();

        app(History::class)->silently(function () {
            $this->prepareAccounts();
            $this->prepareDictionaries();
            $this->preparePeople();
            $this->openingBalances();

            foreach ($this->factMonths() as $month) {
                $this->sales($month);
                $this->purchases($month);
                $this->expenses($month);
            }

            $this->profitTax();
            $this->dividends();
            $this->equipment();
            $this->settlePayables();
            $this->collectReceivables();
            $this->transfers();

            $this->flushOperations();
            $this->budgets();
        });

        $this->report();

        return self::SUCCESS;
    }

    // ── Подготовка ───────────────────────────────────────────────────────────

    /** Снести учётные данные, оставив план счетов и настройки */
    private function wipe(): void
    {
        foreach (['operations', 'document_items', 'documents', 'budget_items',
                  'budget_opening_balances', 'budget_documents', 'object_versions',
                  'info', 'bulk_update_log'] as $table) {
            DB::connection($this->db)->table($table)->delete();
        }

        $this->warn('Учётные данные тенанта снесены');
    }

    /**
     * Счета под торговлю.
     *
     * Новый тенант получает минимум; торговле нужны авансы в обе стороны,
     * кредитная линия, основные средства и отдельный счёт поставщиков услуг —
     * иначе кредиторка за товар смешается с арендой и связью.
     */
    private function prepareAccounts(): void
    {
        $have = DB::connection($this->db)->table('balance_items')->pluck('id', 'code')->all();

        foreach (['А410', 'А500', 'П150', 'П310', 'П360'] as $code) {
            if (isset($have[$code])) continue;

            $a = ChartOfAccounts::byCode($code);

            // С каталожным id: так счета совпадают между базами, и перенос
            // данных между тенантами не превращается в ребус
            DB::connection($this->db)->table('balance_items')->insert([
                'id'           => $a['id'],
                'parent_id'    => isset($a['parent_code']) ? ($have[$a['parent_code']] ?? null) : null,
                'name'         => $a['name'],
                'code'         => $a['code'],
                'info_1_type'  => $a['info_1_type'] ?? null,
                'info_2_type'  => $a['info_2_type'] ?? null,
                'info_3_type'  => null,
                'is_system'    => 1,
                'has_quantity' => $a['has_quantity'] ?? 0,
                'created_at'   => now(), 'updated_at' => now(),
            ]);

            $have[$code] = (int) $a['id'];
        }

        $this->acc = $have;

        // Суммовой учёт: количество у товара не ведём вовсе
        DB::connection($this->db)->table('balance_items')
            ->where('code', 'А200')->update(['has_quantity' => 0]);

        // Разрез расходов по отделам: без слота группировать не по чему, и
        // двухуровневый БДР «Отдел → Статья» было бы не собрать
        DB::connection($this->db)->table('balance_items')
            ->where('code', 'П589')->update(['info_2_type' => 'department']);

        // Накладные без количества и цены — это и есть суммовой учёт в форме
        DB::connection($this->db)->table('document_types')
            ->whereIn('code', ['incoming_invoice', 'outgoing_invoice'])
            ->update(['show_quantity' => 0, 'show_price' => 0, 'show_vat' => 0]);
    }

    private function prepareDictionaries(): void
    {
        DictionaryTemplates::apply('trade', $this->db);

        foreach (DB::connection($this->db)->table('info')->get(['id', 'type', 'code']) as $row) {
            if ($row->code) $this->info[$row->type . '|' . $row->code] = (int) $row->id;
        }

        $project = DB::connection($this->db)->table('projects')->first();
        $this->projectId = (int) $project->id;
        $this->userId    = (int) DB::connection($this->db)->table('users')->min('id');

        // Расходная накладная берёт счета и статью дохода из проекта
        DB::connection($this->db)->table('projects')->where('id', $this->projectId)->update([
            'outgoing_revenue_bi_id'   => $this->acc['П587'],
            'outgoing_cogs_bi_id'      => $this->acc['П588'],
            'outgoing_revenue_item_id' => $this->info['revenue|SALES-REG'],
            'updated_at'               => now(),
        ]);
    }

    /** Покупатели, поставщики, сотрудники */
    private function preparePeople(): void
    {
        $buyers = [
            'ТС «Пятёрочка-Юг», ООО', 'ТС «Магнит-Регион», АО', 'ТС «Лента-Поволжье», ООО',
            'ТД «Весна», ООО', 'Торговый дом «Апрель», ООО', 'ГК «Снабжение», ООО',
            'Оптовик-Урал, ООО', 'Сибирский Торг, АО', 'Волга-Опт, ООО',
            'Дон-Трейд, ООО', 'Северный Склад, ООО', 'Балтика-Поставка, ООО',
            'Центр-Опт, ООО', 'Альянс-Трейд, ООО', 'Меркурий-Групп, ООО',
            'Регион-Снаб, ООО', 'Партнёр-Опт, ООО', 'Логистик-Трейд, ООО',
            'Юг-Дистрибуция, ООО', 'Восток-Торг, ООО', 'Прайм-Опт, ООО',
            'Гермес-Трейд, ООО', 'Контур-Снаб, ООО', 'Вектор-Опт, ООО',
            'Статус-Торг, ООО', 'База №1, ООО', 'Оптторг-Н, ООО',
            'Рассвет-Опт, ООО', 'Магистраль-Трейд, ООО', 'Союз-Снаб, ООО',
            'ИП Абрамов К. Л.', 'ИП Нечаева О. В.', 'ИП Гладков П. С.',
            'ИП Усольцев Д. А.', 'ИП Коновалова Е. М.', 'Сеть «Домовой», ООО',
            'Хозторг-Сервис, ООО', 'Триумф-Опт, ООО', 'Каскад-Трейд, ООО', 'Фортуна-Опт, ООО',
        ];

        $vendors = [
            'Завод «Промтех», АО', 'Фабрика «Заря», ООО', 'Комбинат «Восход», АО',
            'Импорт-Групп, ООО', 'Техноимпорт, ООО', 'Производственник, ООО',
            'Мануфактура Юга, ООО', 'Полимер-Про, ООО', 'Стандарт-Пром, ООО',
            'Евро-Поставка, ООО', 'Первая Фабрика, ООО', 'Индустрия-Н, АО',
            'Сырьё и Материалы, ООО', 'Профиль-Трейд, ООО', 'Грандпром, ООО',
            'Опт-Мастер, ООО', 'Галактика-Пром, ООО', 'Ресурс-Поставка, ООО',
        ];

        $services = [
            'Складской комплекс «Северный», ООО', 'Бизнес-центр «Меридиан», ООО',
            'Транспортная компания «Путь», ООО', 'ТК «Автолайн», ООО',
            'Упаковка-Сервис, ООО', 'Рекламное агентство «Фокус», ООО',
            'IT-Партнёр, ООО', 'Аудит-Консалт, ООО', 'Хозтовары-Опт, ООО',
            'Сервис-Техника, ООО', 'ТехноСклад, ООО',
        ];

        // Оклады подобраны так, чтобы ФОТ отдела в точности совпал со статьёй
        // плана (self::FIXED): иначе план-факт по зарплате расходился бы не
        // из-за экономики, а из-за несведённого справочника
        $staff = [
            ['Балашов А. И.',    'ADM',    90_000],
            ['Нурсултанова Г.',  'ADM',    55_000],
            ['Ефремов С. П.',    'SALES', 110_000],
            ['Логинова М. А.',   'SALES',  95_000],
            ['Тарасов Д. В.',    'SALES',  85_000],
            ['Градов П. Н.',     'WH',     90_000],
            ['Ильин А. А.',      'WH',     75_000],
            ['Суворова Л. М.',   'WH',     75_000],
            ['Макаров Е. Ю.',    'WH',     70_000],
        ];

        foreach ($buyers as $i => $name)   $this->buyers[$this->partner($name, $i)] = $name;
        foreach ($vendors as $i => $name)  $this->vendors[$this->partner($name, 100 + $i)] = $name;
        foreach ($services as $i => $name) $this->services[$this->partner($name, 200 + $i)] = $name;

        $this->owner  = $this->partner('Собственник', 900);
        $this->taxman = $this->partner('ФНС России', 901);
        $this->banker = $this->partner('Банк «Открытие», ПАО', 902);

        foreach ($staff as $i => [$name, $dept, $salary]) {
            $id = DB::connection($this->db)->table('info')->insertGetId([
                'name' => $name, 'type' => 'employee', 'code' => 'EMP-' . (101 + $i),
                'sort_order' => $i, 'is_active' => 1,
                'expense_kind' => 'fixed', 'flow_kind' => 'operating',
                'created_at' => now(), 'updated_at' => now(),
            ]);
            $this->staff[$id] = ['name' => $name, 'dept' => $dept, 'salary' => $salary];
        }
    }

    private function partner(string $name, int $order): int
    {
        return DB::connection($this->db)->table('info')->insertGetId([
            'name' => $name, 'type' => 'partner', 'code' => null,
            'inn' => (string) mt_rand(5_000_000_000, 7_999_999_999),
            'sort_order' => $order, 'is_active' => 1,
            'expense_kind' => 'fixed', 'flow_kind' => 'operating',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    // ── Начальные остатки ────────────────────────────────────────────────────

    /**
     * Вступительное сальдо на 31 декабря 2025 года.
     *
     * Компания работает давно, в FINDIR пришла с начала года — это обычный
     * случай, и демо честнее показывает его, чем бизнес, возникший из ничего.
     * Балансирует всё операционный капитал, из него же выделяется вклад
     * собственника.
     *
     * Величины подобраны под январский масштаб, а не под среднегодовой: год
     * растёт, и вход в него с декабрьскими оборотами выглядел бы так, будто
     * компания внезапно просела.
     */
    private function openingBalances(): void
    {
        $at   = Carbon::parse(self::OPENING_AT);
        $from = Carbon::parse(self::PERIOD_FROM);
        $cap  = $this->acc['П550'];
        $note = 'Ввод начальных остатков на 31.12.2025';

        // Деньги
        foreach (['BANK-A' => 4_500_000, 'BANK-B' => 1_200_000, 'CASH' => 300_000] as $code => $sum) {
            $this->op($at, $sum, $this->acc['А100'], [$this->info['cash|' . $code], null], $cap, [null], $note);
        }

        // Дебиторка: 18 покупателей, рассчитаются в январе–феврале
        $buyerIds = array_keys($this->buyers);
        $left = 22_000_000;
        for ($i = 0; $i < 18; $i++) {
            $sum = $i === 17 ? $left : round($left / (18 - $i) * (mt_rand(60, 150) / 100), -3);
            $sum = min($sum, $left);
            $left -= $sum;
            $partner = $buyerIds[$i];

            $this->op($at, $sum, $this->acc['А300'], [$partner], $cap, [null], $note);
            $this->receivable[] = ['partner' => $partner, 'sum' => $sum, 'left' => $sum,
                                   'due' => $from->copy()->addDays(mt_rand(2, 45))];
        }

        // Товар на складе и основные средства
        $this->op($at, 18_000_000, $this->acc['А200'],
            [$this->info['product|TOVAR'], $this->info['department|WH']], $cap, [null], $note);
        $this->op($at, 5_000_000, $this->acc['А500'], [null, null], $cap, [null], $note);

        // Авансы поставщикам
        $vendorIds = array_keys($this->vendors);
        foreach (array_slice($vendorIds, 0, 3) as $k => $v) {
            $this->op($at, [1_000_000, 600_000, 400_000][$k], $this->acc['А410'], [$v], $cap, [null], $note);
        }

        // Кредиторка перед поставщиками: закроется в январе
        $left = 13_000_000;
        foreach (array_slice($vendorIds, 0, 9) as $i => $v) {
            $sum = $i === 8 ? $left : round($left / (9 - $i) * (mt_rand(70, 140) / 100), -3);
            $sum = min($sum, $left);
            $left -= $sum;

            $this->op($at, $sum, $cap, [null], $this->acc['П100'], [$v], $note);
            $this->payable[] = ['partner' => $v, 'sum' => $sum, 'left' => $sum,
                                'due' => $from->copy()->addDays(mt_rand(1, 28))];
        }

        // Авансы покупателей
        foreach (array_slice($buyerIds, 20, 2) as $k => $b) {
            $this->op($at, [800_000, 400_000][$k], $cap, [null], $this->acc['П310'], [$b], $note);
        }

        // Зарплата за декабрь и налоги — выплачиваются в январе
        foreach ($this->staff as $id => $s) {
            $this->op($at, $s['salary'], $cap, [null], $this->acc['П335'], [$id], $note);
        }
        $this->op($at, 1_500_000, $cap, [null], $this->acc['П340'], [$this->taxman], $note);

        // Кредитная линия и вклад собственника
        $this->op($at, self::OPENING_DEBT, $cap, [null], $this->acc['П360'], [$this->banker], $note);
        $this->op($at, 15_000_000, $cap, [null], $this->acc['П505'], [$this->owner],
            'Вклад собственника в капитал компании');
    }

    // ── Факт: отгрузки и закупки документами ─────────────────────────────────

    /** @return Carbon[] первые числа месяцев факта */
    private function factMonths(): array
    {
        return array_map(fn($m) => Carbon::create(2026, $m, 1), array_keys(self::FACT_VS_PLAN));
    }

    private function planRevenue(int $month): float
    {
        return self::PLAN_YEAR_REVENUE * self::PLAN_SHARE[$month] / 100;
    }

    private function factRevenue(int $month): float
    {
        return $this->planRevenue($month) * self::FACT_VS_PLAN[$month];
    }

    /** Отгрузки месяца расходными накладными: 45–55 штук, суммовой учёт */
    private function sales(Carbon $month): void
    {
        $target   = $this->factRevenue($month->month);
        $buyerIds = array_keys($this->buyers);
        $days     = $month->daysInMonth;

        $count = mt_rand(45, 55);
        $weights = [];
        for ($i = 0; $i < $count; $i++) $weights[] = mt_rand(30, 260);
        $total = array_sum($weights);

        foreach ($weights as $i => $w) {
            $amount = round($target * $w / $total, -2);
            if ($amount < 50_000) continue;

            $date    = $month->copy()->addDays(mt_rand(0, $days - 1))->setTime(mt_rand(9, 18), mt_rand(0, 59));
            $buyer   = $buyerIds[mt_rand(0, count($buyerIds) - 1)];
            $channel = $this->pickChannel();
            $cost    = round($amount * self::CHANNELS[$channel]['cost'] * (mt_rand(985, 1015) / 1000), -2);

            $docId = $this->document('outgoing_invoice', $date, $buyer, $amount, [
                'revenue_bi_id'   => $this->acc['П587'],
                'cogs_bi_id'      => $this->acc['П588'],
                'revenue_item_id' => $this->info['revenue|' . $channel],
            ], [[
                'bi_id'       => $this->acc['А200'],
                'info_1_id'   => $this->info['product|TOVAR'],
                'info_2_id'   => $this->info['department|WH'],
                'amount'      => $amount,
                'amount_cost' => $cost,
                'kind'        => 'sale',
                'content'     => 'Отгрузка товара (суммовой учёт)',
            ]]);

            $this->post($docId);

            $this->receivable[] = ['partner' => $buyer, 'sum' => $amount, 'left' => $amount,
                                   'due' => $date->copy()->addDays(mt_rand(25, 60))->startOfDay()];

            $q = (int) ceil($month->month / 3);
            $this->pnl[$q]['revenue'] = ($this->pnl[$q]['revenue'] ?? 0) + $amount;
            $this->pnl[$q]['cost']    = ($this->pnl[$q]['cost'] ?? 0) + $cost;
        }
    }

    private function pickChannel(): string
    {
        $r = mt_rand(1, 100) / 100;
        $acc = 0;
        foreach (self::CHANNELS as $code => $c) {
            $acc += $c['share'];
            if ($r <= $acc) return $code;
        }
        return array_key_first(self::CHANNELS);
    }

    /**
     * Закупки месяца приходными накладными.
     *
     * Объём — себестоимость месяца плюс небольшой прирост склада: торговля
     * закупает вперёд, и запас должен расти вместе с оборотом.
     */
    private function purchases(Carbon $month): void
    {
        // Закупаем себестоимость месяца плюс небольшой прирост запаса
        $target = $this->factRevenue($month->month) * 0.78 * 1.025;

        $vendorIds = array_keys($this->vendors);
        $days      = $month->daysInMonth;
        $count     = mt_rand(22, 28);

        $weights = [];
        for ($i = 0; $i < $count; $i++) $weights[] = mt_rand(40, 200);
        $total = array_sum($weights);

        foreach ($weights as $w) {
            $amount = round($target * $w / $total, -2);
            if ($amount < 100_000) continue;

            $date   = $month->copy()->addDays(mt_rand(0, $days - 1))->setTime(mt_rand(9, 17), mt_rand(0, 59));
            $vendor = $vendorIds[mt_rand(0, count($vendorIds) - 1)];

            $docId = $this->document('incoming_invoice', $date, $vendor, $amount, [], [[
                'bi_id'     => $this->acc['А200'],
                'info_1_id' => $this->info['product|TOVAR'],
                'info_2_id' => $this->info['department|WH'],
                'amount'    => $amount,
                'content'   => 'Поступление товара (суммовой учёт)',
            ]]);

            $this->post($docId);

            $this->payable[] = ['partner' => $vendor, 'sum' => $amount, 'left' => $amount,
                                'due' => $date->copy()->addDays(mt_rand(20, 45))->startOfDay()];
        }
    }

    /** Шапка документа и его строки */
    private function document(string $type, Carbon $date, int $partner, float $amount, array $extra, array $items): int
    {
        $number = DB::connection($this->db)->table('documents')->where('type', $type)->count() + 1;

        $id = DB::connection($this->db)->table('documents')->insertGetId($extra + [
            'date'       => $date->format('Y-m-d H:i:s'),
            'number'     => (string) $number,
            'project_id' => $this->projectId,
            'type'       => $type,
            'status'     => 'draft',
            'created_by' => $this->userId,
            'bi_id'      => $type === 'outgoing_invoice' ? $this->acc['А300'] : $this->acc['П100'],
            'info_1_id'  => $partner,
            'amount'     => $amount,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        foreach ($items as $i => $item) {
            DB::connection($this->db)->table('document_items')->insert($item + [
                'document_id' => $id,
                'sort_order'  => $i,
                'quantity'    => 0,
                'price'       => 0,
                'created_at'  => now(), 'updated_at' => now(),
            ]);
        }

        return $id;
    }

    private function post(int $documentId): void
    {
        $doc = Document::on($this->db)->find($documentId);
        DocumentService::post($doc);
    }

    // ── Факт: расходы ────────────────────────────────────────────────────────

    /**
     * Расходы месяца: начисление и оплата.
     *
     * Переменные считаются от выручки месяца, постоянные стоят суммой. ФОТ
     * начисляется сотрудникам и выплачивается 10-го следующего месяца, взносы —
     * 15-го: ровно поэтому во вступительном сальдо есть долг по зарплате.
     */
    private function expenses(Carbon $month): void
    {
        $revenue = $this->factRevenue($month->month);
        $end     = $month->copy()->endOfMonth()->setTime(18, 0);
        $q       = (int) ceil($month->month / 3);
        $vendors = array_keys($this->services);

        // Переменные — дважды в месяц, чтобы в журнале это не выглядело разнарядкой
        foreach (self::VARIABLE as $code => $share) {
            // Коды статей числовые, и PHP хранит их ключами-числами: без
            // приведения `$code[0]` обращается к разряду числа, а не к символу
            $code = (string) $code;
            $sum  = $revenue * $share * (mt_rand(94, 106) / 100);

            foreach ([0.5, 0.5] as $k => $part) {
                $date = $month->copy()->addDays($k === 0 ? mt_rand(8, 14) : mt_rand(20, 27))->setTime(15, 0);
                $this->expense($code, round($sum * $part, -2), $date, $vendors);
            }

            $this->pnl[$q]['expenses'] = ($this->pnl[$q]['expenses'] ?? 0) + $sum;
        }

        // Постоянные — раз в месяц. ФОТ без разброса: оклады фиксированы, и
        // «случайная» зарплата выглядела бы ошибкой учёта
        foreach (self::FIXED as $code => $planned) {
            $code = (string) $code;

            if (in_array($code, self::PAYROLL, true)) {
                $sum = $this->payroll($code, $month, $end);
            } else {
                $sum = round($planned * (mt_rand(97, 103) / 100), -2);
                $this->expense($code, $sum, $month->copy()->addDays(mt_rand(3, 24))->setTime(12, 0), $vendors);
            }

            $this->pnl[$q]['expenses'] = ($this->pnl[$q]['expenses'] ?? 0) + $sum;
        }

        // Инвестиционные — разово, в своём месяце
        $investments = [
            2 => ['6010', 120_000], 3  => ['6030', 180_000], 5 => ['6020', 350_000],
            6 => ['6010',  90_000], 7  => ['6030', 230_000], 9 => ['6010',  90_000],
           10 => ['6020', 280_000], 12 => ['6030', 160_000],
        ];
        if (isset($investments[$month->month])) {
            [$code, $sum] = $investments[$month->month];
            $this->expense($code, $sum, $month->copy()->addDays(mt_rand(10, 20))->setTime(14, 0), $vendors);
            $this->pnl[$q]['expenses'] = ($this->pnl[$q]['expenses'] ?? 0) + $sum;
        }

        // Страховые взносы с начисленного ФОТ
        $fot = 0;
        foreach ($this->staff as $s) $fot += $s['salary'];
        $social = round($fot * self::SOCIAL_RATE, -2);

        $this->op($end, $social, $this->acc['П589'],
            [$this->info['expenses|4010'], $this->info['department|ADM']],
            $this->acc['П340'], [$this->taxman], 'Страховые взносы за ' . $this->monthName($month));

        $this->op($month->copy()->addMonth()->day(15)->setTime(11, 0), $social,
            $this->acc['П340'], [$this->taxman],
            $this->acc['А100'], [$this->info['cash|BANK-A'], $this->info['flow|OD-OUT-TAX']],
            'Уплата страховых взносов за ' . $this->monthName($month));

        $this->pnl[$q]['expenses'] = ($this->pnl[$q]['expenses'] ?? 0) + $social;
    }

    /** Начисление расхода поставщику услуг и его оплата через несколько дней */
    private function expense(string $code, float $sum, Carbon $date, array $vendors): void
    {
        if ($sum <= 0) return;

        static $titles = [];

        $expense = $this->info['expenses|' . $code];
        $dept    = $this->info['department|' . self::DEPT_BY_GROUP[$code[0]]];
        $flow    = $this->info['flow|' . self::FLOW_BY_EXPENSE[$code]];
        $title   = $titles[$code] ??= DB::connection($this->db)
            ->table('info')->where('id', $expense)->value('name');

        // Банковские услуги, проценты и факторинг списываются сразу: кредиторки
        // по ним не бывает, банк забирает их сам
        if (in_array($code, self::DIRECT_PAY, true)) {
            $this->op($date, $sum, $this->acc['П589'], [$expense, $dept],
                $this->acc['А100'], [$this->info['cash|BANK-A'], $flow], $title);
            return;
        }

        $vendor = $vendors[mt_rand(0, count($vendors) - 1)];

        $this->op($date, $sum, $this->acc['П589'], [$expense, $dept],
            $this->acc['П150'], [$vendor], $title);

        $this->op($date->copy()->addDays(mt_rand(3, 18))->setTime(11, 0), $sum,
            $this->acc['П150'], [$vendor],
            $this->acc['А100'], [$this->info['cash|BANK-A'], $flow], 'Оплата: ' . $title);
    }

    /**
     * Начисление зарплаты по сотрудникам отдела и выплата 10-го следующего.
     *
     * @return float начисленный ФОТ — он же идёт в расчёт налога на прибыль
     */
    private function payroll(string $code, Carbon $month, Carbon $end): float
    {
        $dept    = self::DEPT_BY_GROUP[$code[0]];
        $expense = $this->info['expenses|' . $code];
        $deptId  = $this->info['department|' . $dept];
        $payday  = $month->copy()->addMonth()->day(10)->setTime(10, 0);
        $total   = 0.0;

        foreach ($this->staff as $id => $s) {
            if ($s['dept'] !== $dept) continue;
            $total += $s['salary'];

            $this->op($end, $s['salary'], $this->acc['П589'], [$expense, $deptId],
                $this->acc['П335'], [$id], 'Зарплата за ' . $this->monthName($month) . ' — ' . $s['name']);

            $this->op($payday, $s['salary'], $this->acc['П335'], [$id],
                $this->acc['А100'], [$this->info['cash|BANK-A'], $this->info['flow|OD-OUT-ZP']],
                'Выплата зарплаты за ' . $this->monthName($month) . ' — ' . $s['name']);
        }

        return $total;
    }

    /** Налог на прибыль по кварталам: от того, что реально заработано */
    private function profitTax(): void
    {
        foreach ([1 => '2026-03-31', 2 => '2026-06-30', 3 => '2026-09-30', 4 => '2026-12-31'] as $q => $day) {
            $p = $this->pnl[$q] ?? [];
            $profit = ($p['revenue'] ?? 0) - ($p['cost'] ?? 0) - ($p['expenses'] ?? 0);
            if ($profit <= 0) continue;

            $tax  = round($profit * self::PROFIT_TAX, -2);
            $date = Carbon::parse($day)->setTime(19, 0);

            $this->op($date, $tax, $this->acc['П589'],
                [$this->info['expenses|4020'], $this->info['department|ADM']],
                $this->acc['П340'], [$this->taxman], "Налог на прибыль за {$q} квартал");

            // Платим в следующем месяце — за четвёртый квартал уже за границей
            // года, поэтому в балансе он остаётся долгом перед бюджетом
            $pay = $date->copy()->addMonth()->day(28)->setTime(11, 0);
            if ($pay->lte(Carbon::parse(self::PERIOD_TO))) {
                $this->op($pay, $tax, $this->acc['П340'], [$this->taxman],
                    $this->acc['А100'], [$this->info['cash|BANK-A'], $this->info['flow|OD-OUT-TAX']],
                    "Уплата налога на прибыль за {$q} квартал");
            }
        }
    }

    /** Дивиденды — дважды за год, после закрытия полугодия и девяти месяцев */
    private function dividends(): void
    {
        foreach ([['2026-08-20 12:00:00', 4_000_000], ['2026-11-19 12:00:00', 3_500_000]] as [$day, $sum]) {
            $this->op(Carbon::parse($day), $sum,
                $this->acc['П555'], [$this->owner],
                $this->acc['А100'], [$this->info['cash|BANK-A'], $this->info['flow|FIN-DIV']],
                'Выплата дивидендов собственнику');
        }
    }

    /** Покупка складской техники: инвестиция в баланс, а не в расходы */
    private function equipment(): void
    {
        foreach ([['2026-06-16 13:00:00', 2_400_000, 'погрузчик и стеллажи'],
                  ['2026-10-14 13:00:00', 1_800_000, 'линия упаковки и весовое оборудование']] as [$day, $sum, $what]) {
            $this->op(Carbon::parse($day), $sum,
                $this->acc['А500'], [null, null],
                $this->acc['А100'], [$this->info['cash|BANK-A'], $this->info['flow|INV-EQUIP']],
                'Покупка складской техники: ' . $what);
        }
    }

    // ── Деньги ───────────────────────────────────────────────────────────────

    /** Оплата покупателей по срокам: что не наступило — осталось дебиторкой */
    private function collectReceivables(): void
    {
        $limit = Carbon::parse(self::PERIOD_TO . ' 23:59:59');

        foreach ($this->receivable as &$r) {
            if ($r['due']->gt($limit)) continue;

            // Часть покупателей платит двумя частями — так бывает чаще, чем
            // ровно в срок и целиком
            $parts = mt_rand(1, 100) <= 25 ? 2 : 1;
            $left  = $r['left'];

            for ($i = 0; $i < $parts; $i++) {
                $sum  = $i === $parts - 1 ? $left : round($left * 0.5, -2);
                $date = $r['due']->copy()->addDays($i * mt_rand(5, 15))->setTime(mt_rand(10, 17), mt_rand(0, 59));
                if ($date->gt($limit)) break;

                $cash = mt_rand(1, 100) <= 8 ? 'BANK-B' : 'BANK-A';

                $this->op($date, $sum, $this->acc['А100'],
                    [$this->info['cash|' . $cash], $this->info['flow|OD-IN-CUST']],
                    $this->acc['А300'], [$r['partner']],
                    'Оплата от покупателя: ' . $this->buyers[$r['partner']]);

                $left -= $sum;
                $r['left'] = $left;
            }
        }
    }

    /** Оплата поставщикам товара по срокам */
    private function settlePayables(): void
    {
        $limit = Carbon::parse(self::PERIOD_TO . ' 23:59:59');

        foreach ($this->payable as &$p) {
            if ($p['due']->gt($limit)) continue;

            $date = $p['due']->copy()->setTime(mt_rand(10, 16), mt_rand(0, 59));

            $this->op($date, $p['left'], $this->acc['П100'], [$p['partner']],
                $this->acc['А100'], [$this->info['cash|BANK-A'], $this->info['flow|OD-OUT-GOODS']],
                'Оплата поставщику: ' . $this->vendors[$p['partner']]);

            $p['left'] = 0;
        }
    }

    /** Перемещения между счетами: в ОДДС они не должны считаться движением */
    private function transfers(): void
    {
        foreach ([[2, 1_100_000], [4, 1_500_000], [6, 900_000],
                  [8, 1_200_000], [10, 1_600_000], [12, 1_000_000]] as [$m, $sum]) {
            $date = Carbon::create(2026, $m, mt_rand(10, 20), 14, 0);
            $flow = $this->info['flow|OD-TRF'];

            $this->op($date, $sum, $this->acc['А100'], [$this->info['cash|BANK-B'], $flow],
                $this->acc['А100'], [$this->info['cash|BANK-A'], $flow],
                'Перевод между расчётными счетами');
        }
    }

    // ── Запись операций и кредитная линия ────────────────────────────────────

    /**
     * Накопить операцию. Стороны передаются набором аналитик по слотам счёта:
     * первый элемент в первый слот, второй во второй.
     */
    private function op(Carbon $date, float $amount, int $inBi, array $inInfo, int $outBi, array $outInfo, string $content): void
    {
        if ($amount <= 0) return;

        $this->ops[] = [
            'date'          => $date->copy(),
            'amount'        => round($amount, 2),
            'in_bi_id'      => $inBi,
            'in_info_1_id'  => $inInfo[0] ?? null,
            'in_info_2_id'  => $inInfo[1] ?? null,
            'out_bi_id'     => $outBi,
            'out_info_1_id' => $outInfo[0] ?? null,
            'out_info_2_id' => $outInfo[1] ?? null,
            'content'       => $content,
        ];
    }

    /**
     * Записать накопленное, подобрав по дороге кредитную линию.
     *
     * Операции сортируются по дате, остаток денег считается нарастающим итогом,
     * и как только он проваливается ниже порога — выбирается транш, как только
     * поднимается выше потолка — гасится. Без этого демо показывало бы минус на
     * расчётном счёте, чего в жизни не бывает.
     */
    private function flushOperations(): void
    {
        usort($this->ops, fn($a, $b) => $a['date']->timestamp <=> $b['date']->timestamp);

        $cashAccount = $this->acc['А100'];
        $balance     = 0.0;
        // Линия уже выбрана вступительным сальдо — иначе казначейство не смогло
        // бы её гасить, только добирать
        $debt        = (float) self::OPENING_DEBT;
        $withCredit  = [];
        $lastDay     = null;

        foreach ($this->ops as $op) {
            $day = $op['date']->format('Y-m-d');

            // Казначейство смотрит на остаток раз в день, а не после каждой проводки
            if ($lastDay !== null && $day !== $lastDay) {
                $withCredit = array_merge($withCredit, $this->creditMoves($balance, $debt, $op['date']));
            }
            $lastDay = $day;

            if ($op['in_bi_id'] === $cashAccount)  $balance += $op['amount'];
            if ($op['out_bi_id'] === $cashAccount) $balance -= $op['amount'];

            $withCredit[] = $op;
        }

        $rows = [];
        foreach ($withCredit as $op) {
            $rows[] = [
                'date'          => $op['date']->format('Y-m-d H:i:s'),
                'project_id'    => $this->projectId,
                'amount'        => $op['amount'],
                'quantity'      => 0,
                'in_bi_id'      => $op['in_bi_id'],
                'in_info_1_id'  => $op['in_info_1_id'],
                'in_info_2_id'  => $op['in_info_2_id'],
                'in_info_3_id'  => null,
                'in_quantity'   => 0,
                'out_bi_id'     => $op['out_bi_id'],
                'out_info_1_id' => $op['out_info_1_id'],
                'out_info_2_id' => $op['out_info_2_id'],
                'out_info_3_id' => null,
                'out_quantity'  => 0,
                'content'       => $op['content'],
                'note'          => null,
                'source'        => 'manual',
                'created_by'    => $this->userId,
                'is_posted'     => 1,
                'created_at'    => now(),
                'updated_at'    => now(),
            ];
        }

        foreach (array_chunk($rows, 200) as $chunk) {
            DB::connection($this->db)->table('operations')->insert($chunk);
        }
    }

    /** Транш или погашение кредитной линии, если остаток вышел из коридора */
    private function creditMoves(float &$balance, float &$debt, Carbon $date): array
    {
        $out = [];
        $at  = $date->copy()->setTime(9, 0);

        if ($balance < self::CASH_FLOOR) {
            $need = ceil((self::CASH_FLOOR * 2 - $balance) / 1_000_000) * 1_000_000;

            $out[] = [
                'date' => $at, 'amount' => $need,
                'in_bi_id'  => $this->acc['А100'],
                'in_info_1_id' => $this->info['cash|BANK-A'], 'in_info_2_id' => $this->info['flow|FIN-LOAN-IN'],
                'out_bi_id' => $this->acc['П360'],
                'out_info_1_id' => $this->banker, 'out_info_2_id' => null,
                'content' => 'Выборка транша кредитной линии',
            ];

            $balance += $need;
            $debt    += $need;
        } elseif ($balance > self::CASH_CEIL && $debt > 0) {
            $back = min($debt, floor(($balance - self::CASH_CEIL) / 1_000_000) * 1_000_000);

            if ($back > 0) {
                $out[] = [
                    'date' => $at, 'amount' => $back,
                    'in_bi_id'  => $this->acc['П360'],
                    'in_info_1_id' => $this->banker, 'in_info_2_id' => null,
                    'out_bi_id' => $this->acc['А100'],
                    'out_info_1_id' => $this->info['cash|BANK-A'], 'out_info_2_id' => $this->info['flow|FIN-LOAN-OUT'],
                    'content' => 'Частичное погашение кредитной линии',
                ];

                $balance -= $back;
                $debt    -= $back;
            }
        }

        return $out;
    }

    // ── Бюджеты ──────────────────────────────────────────────────────────────

    private function budgets(): void
    {
        $this->budgetBdr();
        $this->budgetDds();
        $this->paymentCalendar();
    }

    /** БДР на календарный год: разрез доходов по каналам, расходов по отделам */
    private function budgetBdr(): void
    {
        $id = DB::connection($this->db)->table('budget_documents')->insertGetId([
            'name'        => 'БДР 2026',
            'type'        => 'bdr',
            'period_from' => '2026-01-01',
            'period_to'   => '2026-12-31',
            'project_id'  => $this->projectId,
            'status'      => 'approved',
            'structure'   => json_encode([
                'revenue'  => [['type' => 'revenue', 'tree' => true]],
                'cost'     => [['type' => 'revenue', 'tree' => true]],
                'expenses' => [['type' => 'department', 'tree' => true], ['type' => 'expenses', 'tree' => true]],
            ], JSON_UNESCAPED_UNICODE),
            'created_by'  => $this->userId,
            'created_at'  => now(), 'updated_at' => now(),
        ]);

        $rows = [];

        foreach (array_keys(self::PLAN_SHARE) as $month) {
            $period  = Carbon::create(2026, $month, 1)->format('Y-m-d');
            $revenue = $this->planRevenue($month);

            foreach (self::CHANNELS as $code => $c) {
                $sum = $revenue * $c['share'];

                $rows[] = $this->planRow($id, 'revenue', $period, round($sum, -3),
                    $this->info['revenue|' . $code]);
                $rows[] = $this->planRow($id, 'cost', $period, round($sum * $c['cost'], -3),
                    $this->info['revenue|' . $code]);
            }

            foreach (self::VARIABLE as $code => $share) {
                $code = (string) $code;
                $rows[] = $this->planRow($id, 'expenses', $period, round($revenue * $share, -3),
                    $this->info['department|' . self::DEPT_BY_GROUP[$code[0]]], $this->info['expenses|' . $code]);
            }

            foreach (self::FIXED as $code => $sum) {
                $code = (string) $code;
                $rows[] = $this->planRow($id, 'expenses', $period, $sum,
                    $this->info['department|' . self::DEPT_BY_GROUP[$code[0]]], $this->info['expenses|' . $code]);
            }

            // Взносы и налог на прибыль плана
            $fot = 0;
            foreach (self::PAYROLL as $code) $fot += self::FIXED[$code];
            $social = round($fot * self::SOCIAL_RATE, -3);

            $rows[] = $this->planRow($id, 'expenses', $period, $social,
                $this->info['department|ADM'], $this->info['expenses|4010']);

            $rows[] = $this->planRow($id, 'expenses', $period, round($this->planInvestment($month), -3),
                $this->info['department|ADM'], $this->info['expenses|6010']);

            $gross    = $revenue - array_sum(array_map(fn($c) => $revenue * $c['share'] * $c['cost'], self::CHANNELS));
            $variable = $revenue * array_sum(self::VARIABLE);
            $fixed    = array_sum(self::FIXED) + $social;
            $profit   = $gross - $variable - $fixed - $this->planInvestment($month);

            if ($profit > 0) {
                $rows[] = $this->planRow($id, 'expenses', $period, round($profit * self::PROFIT_TAX, -3),
                    $this->info['department|ADM'], $this->info['expenses|4020']);
            }
        }

        foreach (array_chunk($rows, 200) as $chunk) {
            DB::connection($this->db)->table('budget_items')->insert($chunk);
        }
    }

    /** Плановые инвестиции: ремонт и автоматизация не каждый месяц */
    private function planInvestment(int $month): float
    {
        return in_array($month, [3, 5, 7, 9, 11], true) ? 250_000 : 80_000;
    }

    private function planRow(int $docId, string $section, string $period, float $amount, int $article, ?int $article2 = null): array
    {
        return [
            'budget_document_id' => $docId,
            'section'            => $section,
            'article_id'         => $article,
            'article_2_id'       => $article2,
            'article_3_id'       => null,
            'cash_id'            => null,
            'period_date'        => $period,
            'amount'             => $amount,
            'content'            => null,
            'created_at'         => now(), 'updated_at' => now(),
        ];
    }

    /** БДДС на год по статьям движения денег */
    private function budgetDds(): void
    {
        $id = DB::connection($this->db)->table('budget_documents')->insertGetId([
            'name'        => 'БДДС 2026',
            'type'        => 'dds',
            'period_from' => '2026-01-01',
            'period_to'   => '2026-12-31',
            'project_id'  => $this->projectId,
            'status'      => 'approved',
            'created_by'  => $this->userId,
            'created_at'  => now(), 'updated_at' => now(),
        ]);

        // Входящий остаток денег на начало года — по каждому счёту, теми же
        // суммами, что во вступительном сальдо: иначе БДДС разойдётся с фактом
        // на первой же строке
        foreach (['BANK-A' => 4_500_000, 'BANK-B' => 1_200_000, 'CASH' => 300_000] as $code => $sum) {
            DB::connection($this->db)->table('budget_opening_balances')->insert([
                'budget_document_id' => $id,
                'cash_id'            => $this->info['cash|' . $code],
                'amount'             => $sum,
                'is_manual'          => 1,
                'created_at'         => now(), 'updated_at' => now(),
            ]);
        }

        $rows = [];

        foreach (array_keys(self::PLAN_SHARE) as $month) {
            $period  = Carbon::create(2026, $month, 1)->format('Y-m-d');
            $revenue = $this->planRevenue($month);
            $cost    = array_sum(array_map(fn($c) => $revenue * $c['share'] * $c['cost'], self::CHANNELS));

            $plan = [
                'OD-IN-CUST'   => $revenue * 0.98,
                'OD-OUT-GOODS' => $cost * 1.01,
                'FIN-INT'      => self::FIXED['5010'],
            ];

            // Остальные выплаты — по статьям ДДС, в которые ложатся расходы
            foreach (self::VARIABLE as $code => $share) {
                $flow = self::FLOW_BY_EXPENSE[$code];
                $plan[$flow] = ($plan[$flow] ?? 0) + $revenue * $share;
            }
            foreach (self::FIXED as $code => $sum) {
                // Проценты уже стоят в плане отдельной статьёй финансовой
                // деятельности — второй раз в операционные выплаты не идут
                if ((string) $code === '5010') continue;
                $flow = self::FLOW_BY_EXPENSE[$code];
                $plan[$flow] = ($plan[$flow] ?? 0) + $sum;
            }

            $fot = 0;
            foreach (self::PAYROLL as $code) $fot += self::FIXED[$code];
            $plan['OD-OUT-TAX'] = ($plan['OD-OUT-TAX'] ?? 0) + $fot * self::SOCIAL_RATE;

            $plan['INV-EQUIP'] = $this->planInvestment($month);

            foreach ($plan as $code => $sum) {
                if ($sum <= 0) continue;

                $rows[] = [
                    'budget_document_id' => $id,
                    'section'            => null,
                    'article_id'         => $this->info['flow|' . $code],
                    'article_2_id'       => null,
                    'article_3_id'       => null,
                    'cash_id'            => null,
                    'period_date'        => $period,
                    'amount'             => round($sum, -3) * $this->flowSign((string) $code),
                    'content'            => null,
                    'created_at'         => now(), 'updated_at' => now(),
                ];
            }
        }

        foreach (array_chunk($rows, 200) as $chunk) {
            DB::connection($this->db)->table('budget_items')->insert($chunk);
        }
    }

    /** +1 у статей поступлений, −1 у выплат */
    private function flowSign(string $code): int
    {
        return in_array($code, self::INFLOW, true) ? 1 : -1;
    }

    // ── Платёжный календарь ──────────────────────────────────────────────────

    /**
     * Календари на декабрь и на январь следующего года.
     *
     * Календарь — не ещё один бюджет, а график: в нём стоят не месячные итоги
     * статей, а конкретные платежи по датам. Поэтому поступления берутся из
     * сроков оплаты отгрузок, а выплаты — из сроков по закупкам: ровно из тех
     * сроков, из которых факт года собрал дебиторку и кредиторку. Декабрь
     * поэтому почти совпадает с фактом, а январь живёт одними ожиданиями —
     * фактов за 2027 год в демо нет, и это правильный вид календаря: он всегда
     * смотрит вперёд.
     *
     * Регулярные платежи — зарплата, взносы, аренда, проценты — стоят на своих
     * числах, а не там, где их заплатил факт. Календарь ведут по графику
     * обязательств, и расхождение в несколько дней между планом и фактом здесь
     * не ошибка данных, а обычная жизнь.
     */
    private function paymentCalendar(): void
    {
        foreach (self::PDC_WINDOWS as [$name, $from, $to, $status]) {
            $fromAt = Carbon::parse($from)->startOfDay();
            $toAt   = Carbon::parse($to)->endOfDay();

            $id = DB::connection($this->db)->table('budget_documents')->insertGetId([
                'name'        => $name,
                'type'        => 'pdc',
                'period_from' => $fromAt->format('Y-m-d'),
                'period_to'   => $toAt->format('Y-m-d'),
                'project_id'  => $this->projectId,
                'status'      => $status,
                'created_by'  => $this->userId,
                'created_at'  => now(), 'updated_at' => now(),
            ]);

            $rows = [];

            foreach ($this->pdcLines($fromAt, $toAt) as [$date, $flow, $amount, $content]) {
                if (round($amount, 2) == 0) continue;

                $rows[] = [
                    'budget_document_id' => $id,
                    'section'            => null,
                    'article_id'         => $this->info['flow|' . $flow],
                    'article_2_id'       => null,
                    'article_3_id'       => null,
                    'cash_id'            => null,
                    'period_date'        => $date->format('Y-m-d'),
                    'amount'             => round($amount, 2),
                    'content'            => $content,
                    'created_at'         => now(), 'updated_at' => now(),
                ];
            }

            foreach (array_chunk($rows, 200) as $chunk) {
                DB::connection($this->db)->table('budget_items')->insert($chunk);
            }
        }
    }

    /**
     * Строки календаря за окно: [дата, статья ДДС, сумма со знаком, назначение].
     *
     * @return array<int, array{0: Carbon, 1: string, 2: float, 3: string}>
     */
    private function pdcLines(Carbon $from, Carbon $to): array
    {
        $inWindow = fn (Carbon $d) => $d->gte($from) && $d->lte($to);
        $lines    = [];

        // Ожидаемые поступления: срок оплаты отгрузки попал в окно. Деньги
        // приходят рабочим днём — банк не проводит платежи в каникулы
        foreach ($this->receivable as $r) {
            if (!$inWindow($r['due'])) continue;

            $lines[] = [$this->businessDay($r['due'], 1), 'OD-IN-CUST', $r['sum'],
                        'Ожидаем оплату: ' . $this->buyers[$r['partner']]];
        }

        // Выплаты поставщикам товара по срокам из приходных накладных
        foreach ($this->payable as $p) {
            if (!$inWindow($p['due'])) continue;

            $lines[] = [$this->businessDay($p['due']), 'OD-OUT-GOODS', -$p['sum'],
                        'Срок оплаты: ' . $this->vendors[$p['partner']]];
        }

        // Регулярные платежи месяцев, которые попадают в окно
        $month = $from->copy()->startOfMonth();
        while ($month->lte($to)) {
            foreach ($this->pdcRegular($month) as $line) {
                if ($inWindow($line[0])) $lines[] = $line;
            }
            $month->addMonth();
        }

        foreach (self::PDC_CREDIT as [$day, $flow, $sum, $content]) {
            $at = Carbon::parse($day);
            if ($inWindow($at)) $lines[] = [$at, $flow, $sum * $this->flowSign($flow), $content];
        }

        return $lines;
    }

    /**
     * Регулярные платежи месяца по своим числам.
     *
     * Постоянные расходы идут суммой из плана, переменные — долей от плановой
     * выручки месяца: логистика и упаковка растут вместе с оборотом, и в
     * календаре это видно по неделям.
     *
     * @return array<int, array{0: Carbon, 1: string, 2: float, 3: string}>
     */
    private function pdcRegular(Carbon $month): array
    {
        $revenue = $this->pdcRevenue($month);
        $fot     = array_sum(array_column($this->staff, 'salary'));
        $social  = round($fot * self::SOCIAL_RATE, -2);
        $prev    = $this->monthName($month->copy()->subMonth());

        // Платят до срока, а не после: выходной сдвигает платёж назад
        $day = fn (int $d) => $this->businessDay($month->copy()->day($d));
        // Доля от плановой выручки по статьям переменных расходов
        $var = fn (string ...$codes) => round(
            $revenue * array_sum(array_map(fn ($c) => self::VARIABLE[$c], $codes)), -3);

        $lines = [
            [$day(5),  'OD-OUT-RENT', -(self::FIXED['1040'] + self::FIXED['3020']), 'Аренда склада и офиса'],
            [$day(10), 'OD-OUT-ZP',   -$fot,                                        'Зарплата за ' . $prev],
            [$day(10), 'OD-OUT-ZP',   -$var('2020'),                                'Бонусы отдела продаж'],
            [$day(15), 'OD-OUT-TAX',  -$social,                                     'Страховые взносы за ' . $prev],
            [$day(18), 'OD-OUT-IT',   -self::FIXED['3030'],                         'IT, связь и ПО'],
            [$day(18), 'OD-OUT-SVC',  -self::FIXED['3040'],                         'Бухгалтерия, юристы, аудит'],
            [$day(20), 'OD-OUT-HOZ',  -(self::FIXED['1060'] + self::FIXED['3050']), 'Хозрасходы и обслуживание склада'],
            [$day(22), 'OD-OUT-PACK', -$var('1030'),                                'Упаковка и расходные материалы'],
            [$day(25), 'OD-OUT-ADV',  -self::FIXED['2030'],                          'Реклама и продвижение'],
            [$day(25), 'OD-OUT-OTH',  -self::FIXED['2040'],                          'Представительские и командировки'],
            [$day(28), 'OD-OUT-TAX',  -self::FIXED['4030'],                          'Прочие налоги и сборы'],
        ];

        // Логистика — по пятницам за неделю. Пятница на каникулах не считается:
        // склад в эти дни не возит, и платить за неделю нечего
        $fridays = [];
        for ($d = $month->copy()->startOfMonth(); $d->month === $month->month; $d->addDay()) {
            if ($d->dayOfWeek === Carbon::FRIDAY && !$this->isDayOff($d)) $fridays[] = $d->copy();
        }
        $perWeek = round($var('1010', '1020') / count($fridays), -3);
        foreach ($fridays as $friday) {
            $lines[] = [$friday, 'OD-OUT-LOG', -$perWeek, 'Доставка покупателям и входящая логистика'];
        }

        // Проценты и банк — последним рабочим днём месяца
        $last = $this->businessDay($month->copy()->endOfMonth()->startOfDay());
        $lines[] = [$last, 'FIN-INT',      -self::FIXED['5010'],                        'Проценты по кредитной линии'];
        $lines[] = [$last, 'OD-OUT-BANK',  -(self::FIXED['3060'] + $var('5020')),       'Банковские услуги и факторинг'];

        if (isset(self::PDC_INVEST[$month->format('Y-m')])) {
            [$d, $flow, $sum, $content] = self::PDC_INVEST[$month->format('Y-m')];
            $lines[] = [$day($d), $flow, -$sum, $content];
        }

        // Налог на прибыль за четвёртый квартал платят 28 января. В факте
        // 2026 года его нет — он остался долгом перед бюджетом, и календарь
        // показывает день, когда этот долг станет платежом
        if ($month->year === 2027 && $month->month === 1) {
            $p   = $this->pnl[4] ?? [];
            $tax = round((($p['revenue'] ?? 0) - ($p['cost'] ?? 0) - ($p['expenses'] ?? 0)) * self::PROFIT_TAX, -3);

            if ($tax > 0) $lines[] = [$day(28), 'OD-OUT-TAX', -$tax, 'Налог на прибыль за 4 квартал 2026'];
        }

        return $lines;
    }

    /** План выручки месяца календаря: за границей года — с ростом */
    private function pdcRevenue(Carbon $month): float
    {
        return $this->planRevenue($month->month) * self::NEXT_YEAR_GROWTH ** max($month->year - 2026, 0);
    }

    /**
     * Рабочий день платежа.
     *
     * Сдвиг не выходит за месяц: январские каникулы иначе отправили бы аренду
     * и зарплату на 31 декабря, то есть вообще за пределы январского
     * календаря, а субботнее поступление в конце месяца — в февраль. Упёрлись
     * в границу — пробуем в другую сторону.
     *
     * @param int $dir −1 — не позже срока (так платят по обязательствам),
     *                 +1 — не раньше (так приходят деньги: банк проводит
     *                 платёж в первый рабочий день)
     */
    private function businessDay(Carbon $date, int $dir = -1): Carbon
    {
        $month = $date->month;

        foreach ([$dir, -$dir] as $step) {
            $d = $date->copy()->startOfDay();

            while ($this->isDayOff($d)) {
                $d->addDays($step);
                if ($d->month !== $month) continue 2;
            }

            return $d;
        }

        return $date->copy()->startOfDay();
    }

    /** Выходной или новогодние каникулы */
    private function isDayOff(Carbon $date): bool
    {
        return $date->isWeekend() || ($date->month === 1 && $date->day <= 8);
    }

    // ── Итог ─────────────────────────────────────────────────────────────────

    private function monthName(Carbon $m): string
    {
        return ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
                'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][$m->month] . ' ' . $m->year;
    }

    private function report(): void
    {
        $saldo = fn(string $code, string $to = self::PERIOD_TO . ' 23:59:59') => (float) DB::connection($this->db)
            ->table('balance_changes as bc')
            ->join('balance_items as bi', 'bi.id', '=', 'bc.bi_id')
            ->where('bi.code', $code)->where('bc.date', '<=', $to)->sum('bc.amount');

        $money = fn($v) => number_format($v, 0, ',', ' ') . ' ₽';

        $ops  = DB::connection($this->db)->table('operations')->whereNull('deleted_at')->count();
        $docs = DB::connection($this->db)->table('documents')->whereNull('deleted_at')->count();

        $revenue = -$saldo('П587');
        $cost    = $saldo('П588');
        $expense = $saldo('П589');
        $profit  = $revenue - $cost - $expense;

        $this->newLine();
        $this->info('Демо-база собрана');
        $this->line("  операций: {$ops}, документов: {$docs}");
        $this->line('  выручка за год: ' . $money($revenue));
        $this->line('  себестоимость: ' . $money($cost) . ' (' . round($cost / $revenue * 100, 1) . '%)');
        $this->line('  расходы: ' . $money($expense));
        $this->line('  чистая прибыль: ' . $money($profit) . ' (' . round($profit / $revenue * 100, 1) . '%)');
        $this->newLine();
        $this->line('  деньги: ' . $money($saldo('А100')));
        $this->line('  дебиторка: ' . $money($saldo('А300')));
        $this->line('  товар на складе: ' . $money($saldo('А200')));
        $this->line('  кредиторка: ' . $money(-$saldo('П100')));
        $this->line('  кредитная линия: ' . $money(-$saldo('П360')));

        $all = (float) DB::connection($this->db)->table('balance_changes')
            ->where('date', '<=', self::PERIOD_TO . ' 23:59:59')->sum('amount');

        $this->newLine();
        $this->line(abs($all) < 0.01
            ? '  баланс сходится: сумма всех сальдо = 0'
            : '  ВНИМАНИЕ: баланс не сходится, расхождение ' . $money($all));

        // Платёжный календарь: план по дням, поэтому в отчёте полезны и оборот,
        // и число строк — пустой календарь виден сразу
        $this->newLine();
        foreach (DB::connection($this->db)->table('budget_documents')->where('type', 'pdc')->get() as $pdc) {
            $items = DB::connection($this->db)->table('budget_items')->where('budget_document_id', $pdc->id);

            $this->line('  ' . $pdc->name . ': строк ' . $items->count()
                . ', поступления ' . $money((clone $items)->where('amount', '>', 0)->sum('amount'))
                . ', выплаты ' . $money((clone $items)->where('amount', '<', 0)->sum('amount')));
        }
    }
}
