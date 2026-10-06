<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Кто ссылается на элемент справочника.
 *
 * Нужно там, где элемент меняет природу или исчезает: сменить справочник у
 * элемента, на который уже сослались операции, — значит переписать прошлое.
 * Контрагент, ставший статьёй расхода, не исчезает из проводок: он остаётся
 * в слоте, объявленном под контрагентов, и отчёты начинают показывать статью
 * там, где ждали контрагента.
 *
 * Отсюда же человек узнаёт, чем занят элемент: `count()` отвечает «сколько»,
 * `lists()` — «чем именно», с переходом в каждый объект.
 *
 * Список мест перечислен явно. Собирать его из information_schema по именам
 * колонок заманчиво, но опасно: `cash_id` в бюджете ссылается на справочник,
 * а `parent_id` у счёта — нет, и угадывание однажды пропустило бы ссылку или
 * придумало несуществующую.
 *
 * `balance_changes` здесь сознательно нет: это производная от операций, её
 * ведут триггеры, и отдельной ссылкой она не является.
 */
final class InfoReferences
{
    /** Таблица → [колонки] с прямой ссылкой на info.id */
    private const COLUMNS = [
        'operations' => ['in_info_1_id', 'in_info_2_id', 'in_info_3_id',
                         'out_info_1_id', 'out_info_2_id', 'out_info_3_id'],
        'documents'  => ['info_1_id', 'info_2_id', 'info_3_id', 'department_id', 'revenue_item_id'],
        'document_items' => ['info_1_id', 'info_2_id', 'info_3_id',
                             'head_info_1_id', 'head_info_2_id', 'head_info_3_id'],
        'budget_items'    => ['article_id', 'article_2_id', 'article_3_id', 'cash_id'],
        'budget_opening_balances' => ['cash_id'],
        'projects'          => ['outgoing_revenue_item_id'],
        'category_postings' => ['flow_info_id'],
        'fund_plan_lines'   => ['flow_info_id'],
        'info'              => ['parent_id', 'default_expense_id'],
    ];

    /** Таблица → колонка с JSON-массивом id элементов */
    private const JSON_LISTS = [
        'funds'        => 'flow_info_ids',
        'fund_schemes' => 'income_flow_ids',
    ];

    /**
     * Строка живёт в документе: [родитель, колонка-ссылка].
     *
     * Своего `deleted_at` у таких таблиц нет, а удалённый документ ссылкой не
     * считается — иначе элемент держали бы строки отчёта, которого уже нет.
     */
    private const PARENTS = [
        'document_items'          => ['documents', 'document_id'],
        'budget_items'            => ['budget_documents', 'budget_document_id'],
        'budget_opening_balances' => ['budget_documents', 'budget_document_id'],
        'fund_plan_lines'         => ['fund_plan_docs', 'doc_id'],
    ];

    /**
     * Какие счета проверять скоупом: закрытое должностью в список не идёт.
     *
     * С именем таблицы: `bi_id` есть и у документа, и у его строки, а список
     * строк эти таблицы джойнит.
     */
    private const SCOPE_COLUMNS = [
        'operations'     => ['operations.in_bi_id', 'operations.out_bi_id'],
        'documents'      => ['documents.bi_id', 'documents.revenue_bi_id', 'documents.cogs_bi_id'],
        'document_items' => ['document_items.bi_id', 'document_items.head_bi_id'],
    ];

    /** Как называть место в сообщении человеку */
    private const LABELS = [
        'operations'              => 'операции',
        'documents'               => 'документы',
        'document_items'          => 'строки документов',
        'budget_items'            => 'строки бюджетов',
        'budget_opening_balances' => 'входящие остатки бюджета',
        'projects'                => 'проекты',
        'category_postings'       => 'карта разноски',
        'fund_plan_lines'         => 'акты финансового планирования',
        'info'                    => 'справочники',
        'funds'                   => 'фонды',
        'fund_schemes'            => 'модели распределения',
        'integration_links'       => 'соответствия интеграций',
    ];

    /** Сколько строк показываем в каждом месте: дальше листать незачем */
    public const LIST_LIMIT = 50;

    /**
     * Где встречается элемент: место → сколько строк. Пустые места опускаем.
     *
     * @return array<string, int>
     */
    public static function count(string $db, int $id): array
    {
        $out = [];

        foreach (self::COLUMNS as $table => $columns) {
            if (!self::has($db, $table)) continue;

            $n = self::query($db, $table, $id)->count();
            if ($n) $out[$table] = $n;
        }

        foreach (self::JSON_LISTS as $table => $column) {
            if (!self::has($db, $table)) continue;

            $n = count(self::jsonRows($db, $table, $column, $id));
            if ($n) $out[$table] = $n;
        }

        if (self::has($db, 'integration_links')) {
            $n = self::linkQuery($db, $id)->count();
            if ($n) $out['integration_links'] = $n;
        }

        return $out;
    }

    /** Есть ли хоть одна ссылка */
    public static function any(string $db, int $id): bool
    {
        return self::count($db, $id) !== [];
    }

    /** «12 — операции, 3 — документы» — для сообщения об отказе */
    public static function describe(array $counts): string
    {
        $parts = [];
        foreach ($counts as $table => $n) {
            $parts[] = $n . ' — ' . (self::LABELS[$table] ?? $table);
        }

        return implode(', ', $parts);
    }

    /**
     * Чем именно занят элемент: по каждому месту — первые строки с подписями.
     *
     * Считаем и перечисляем одним и тем же запросом, поэтому число в заголовке
     * группы всегда совпадает с тем, что в ней видно. Исключение одно —
     * закрытые должностью счета: их строки из списка убираем, но из счёта не
     * вычитаем (ссылка есть, и смену справочника она держит), а в группе
     * поднимаем флаг `restricted`, чтобы расхождение не выглядело ошибкой.
     *
     * @return array{total: int, groups: array<int, array<string, mixed>>}
     */
    public static function lists(string $db, int $id, ?AccountScope $scope = null, int $limit = self::LIST_LIMIT): array
    {
        $hidden = $scope && !$scope->isEmpty() ? $scope->hiddenIds() : [];
        $groups = [];

        foreach (self::count($db, $id) as $table => $n) {
            // Сколько из них человеку вообще видно. Лишний count делаем только
            // при ограничениях: у администратора запрос остаётся прежним
            $visible = $hidden && isset(self::SCOPE_COLUMNS[$table])
                ? self::hide(self::query($db, $table, $id), $hidden, self::SCOPE_COLUMNS[$table])->count()
                : $n;

            $groups[] = [
                'table'      => $table,
                'label'      => self::LABELS[$table] ?? $table,
                'count'      => $n,
                'visible'    => $visible,
                'rows'       => self::rows($db, $table, $id, $hidden, $limit),
                'restricted' => $visible < $n,
            ];
        }

        return [
            'total'  => array_sum(array_column($groups, 'count')),
            'groups' => $groups,
            'limit'  => $limit,
        ];
    }

    /**
     * Запрос «где встречается элемент» — один на подсчёт и на список.
     *
     * Колонки квалифицируем именем таблицы: `info_1_id` есть и у документа, и
     * у его строки, и после джойна запрос без префикса стал бы неоднозначным.
     */
    private static function query(string $db, string $table, int $id)
    {
        $columns = self::COLUMNS[$table];

        $q = DB::connection($db)->table($table)
            ->where(function ($w) use ($table, $columns, $id) {
                foreach ($columns as $c) $w->orWhere("$table.$c", $id);
            });

        // Удалённое не считаем ссылкой: оно уже не участвует ни в отчётах,
        // ни в проводках, и держать из-за него элемент незачем
        if (Schema::connection($db)->hasColumn($table, 'deleted_at')) {
            $q->whereNull("$table.deleted_at");
        }

        [$parent, $fk] = self::PARENTS[$table] ?? [null, null];

        if ($parent && self::has($db, $parent) && Schema::connection($db)->hasColumn($parent, 'deleted_at')) {
            $q->whereExists(fn ($w) => $w->selectRaw('1')->from($parent)
                ->whereColumn("$parent.id", "$table.$fk")
                ->whereNull("$parent.deleted_at"));
        }

        // Сам себя элемент не держит: info.parent_id = свой же id быть не
        // может, но default_expense_id на себя — вполне
        if ($table === 'info') $q->where("$table.id", '!=', $id);

        return $q;
    }

    /** Соответствия интеграций ссылаются парой «тип + номер» */
    private static function linkQuery(string $db, int $id)
    {
        return DB::connection($db)->table('integration_links')
            ->where('local_type', 'info')->where('local_id', $id);
    }

    /** Строки, у которых элемент перечислен в JSON-колонке */
    private static function jsonRows(string $db, string $table, string $column, int $id): array
    {
        $out = [];

        foreach (DB::connection($db)->table($table)->whereNull('deleted_at')->get() as $row) {
            $ids = json_decode((string) ($row->{$column} ?? ''), true);
            if (is_array($ids) && in_array($id, array_map('intval', $ids), true)) $out[] = $row;
        }

        return $out;
    }

    /**
     * Первые строки одного места с человеческими подписями.
     *
     * Подписи собираем на сервере: он уже знает, из каких таблиц что брать, а
     * фронту остаётся показать заголовок, пояснение и, где есть, ссылку на
     * объект.
     *
     * @return array<int, array<string, mixed>>
     */
    private static function rows(string $db, string $table, int $id, array $hidden, int $limit): array
    {
        if ($table === 'integration_links') {
            $rows = self::linkQuery($db, $id)
                ->leftJoin('integrations', 'integrations.id', '=', 'integration_links.integration_id')
                ->orderByDesc('integration_links.id')->limit($limit)
                ->get(['integration_links.id', 'integration_links.entity', 'integration_links.external_id',
                       'integration_links.external_name', 'integrations.name as integration']);

            return $rows->map(fn ($r) => self::row(
                $r->external_name ?: ('№ ' . $r->external_id),
                trim(($r->integration ?: 'интеграция') . ' · ' . $r->entity),
            ))->all();
        }

        if (isset(self::JSON_LISTS[$table])) {
            $rows = array_slice(self::jsonRows($db, $table, self::JSON_LISTS[$table], $id), 0, $limit);

            return array_map(fn ($r) => self::row(
                $r->name ?? ('#' . $r->id),
                $table === 'funds' ? 'фонд, доля ' . self::num($r->percent ?? 0) . ' %' : 'модель распределения',
            ), $rows);
        }

        $q = self::hide(self::query($db, $table, $id), $hidden, self::SCOPE_COLUMNS[$table] ?? []);

        return match ($table) {
            'operations' => $q->orderByDesc('operations.date')->orderByDesc('operations.id')->limit($limit)
                ->get(['operations.id', 'operations.date', 'operations.amount', 'operations.content'])
                ->map(fn ($r) => self::row(
                    '№ ' . $r->id . ' от ' . self::day($r->date),
                    self::money($r->amount) . ($r->content ? ' · ' . $r->content : ''),
                    'operation', (int) $r->id,
                ))->all(),

            'documents' => $q->orderByDesc('documents.date')->orderByDesc('documents.id')->limit($limit)
                ->get(['documents.id', 'documents.date', 'documents.number', 'documents.type',
                       'documents.amount', 'documents.content'])
                ->map(fn ($r) => self::row(
                    self::docType($db, $r->type) . ' № ' . ($r->number ?: $r->id) . ' от ' . self::day($r->date),
                    self::money($r->amount) . ($r->content ? ' · ' . $r->content : ''),
                    'document', (int) $r->id,
                ))->all(),

            // Строка документа сама не открывается — ведём в её документ
            'document_items' => $q
                ->leftJoin('documents', 'documents.id', '=', 'document_items.document_id')
                ->orderByDesc('documents.date')->orderByDesc('document_items.id')->limit($limit)
                ->get(['document_items.id', 'document_items.document_id', 'document_items.content',
                       'document_items.amount', 'documents.number', 'documents.date', 'documents.type'])
                ->map(fn ($r) => self::row(
                    self::docType($db, $r->type) . ' № ' . ($r->number ?: $r->document_id) . ' от ' . self::day($r->date),
                    'строка: ' . self::money($r->amount) . ($r->content ? ' · ' . $r->content : ''),
                    'document', (int) $r->document_id,
                ))->all(),

            'budget_items' => $q
                ->leftJoin('budget_documents', 'budget_documents.id', '=', 'budget_items.budget_document_id')
                ->orderBy('budget_items.period_date')->limit($limit)
                ->get(['budget_items.id', 'budget_items.period_date', 'budget_items.amount',
                       'budget_items.section', 'budget_documents.name'])
                ->map(fn ($r) => self::row(
                    $r->name ?: 'бюджет',
                    self::month($r->period_date) . ' · ' . self::money($r->amount),
                ))->all(),

            'budget_opening_balances' => $q
                ->leftJoin('budget_documents', 'budget_documents.id', '=', 'budget_opening_balances.budget_document_id')
                ->limit($limit)
                ->get(['budget_opening_balances.id', 'budget_opening_balances.amount', 'budget_documents.name'])
                ->map(fn ($r) => self::row(
                    $r->name ?: 'бюджет',
                    'входящий остаток ' . self::money($r->amount),
                ))->all(),

            'projects' => $q->limit($limit)->get(['projects.id', 'projects.name'])
                ->map(fn ($r) => self::row($r->name, 'статья дохода исходящих операций'))->all(),

            'category_postings' => $q->limit($limit)
                ->get(['category_postings.id', 'category_postings.category',
                       'category_postings.counter_account_code', 'category_postings.is_active'])
                ->map(fn ($r) => self::row(
                    'разноска «' . $r->category . '»',
                    trim('счёт ' . $r->counter_account_code . ($r->is_active ? '' : ' · выключена')),
                ))->all(),

            'fund_plan_lines' => $q
                ->leftJoin('fund_plan_docs', 'fund_plan_docs.id', '=', 'fund_plan_lines.doc_id')
                ->leftJoin('funds', 'funds.id', '=', 'fund_plan_lines.fund_id')
                ->orderByDesc('fund_plan_docs.week_start')->limit($limit)
                ->get(['fund_plan_lines.id', 'fund_plan_lines.amount', 'fund_plan_lines.comment',
                       'fund_plan_docs.week_start', 'funds.name as fund'])
                ->map(fn ($r) => self::row(
                    'неделя с ' . self::day($r->week_start),
                    trim(($r->fund ? $r->fund . ' · ' : '') . self::money($r->amount)
                        . ($r->comment ? ' · ' . $r->comment : '')),
                ))->all(),

            'info' => $q->limit($limit)
                ->get(['info.id', 'info.name', 'info.type', 'info.parent_id', 'info.default_expense_id'])
                ->map(fn ($r) => self::row(
                    $r->name,
                    (int) $r->parent_id === $id ? 'вложен в этот элемент' : 'статья расхода по умолчанию',
                    'info', (int) $r->id,
                ))->all(),

            default => [],
        };
    }

    /** Строка списка в том виде, в каком её ждёт фронт */
    private static function row(string $title, string $subtitle = '', ?string $entity = null, ?int $entityId = null): array
    {
        return [
            'title'     => $title,
            'subtitle'  => $subtitle,
            'entity'    => $entity,
            'entity_id' => $entityId,
        ];
    }

    /**
     * Убрать строки по закрытым должностью счетам.
     *
     * Через `whereNull or whereNotIn`, а не просто `whereNotIn`: колонки вроде
     * `revenue_bi_id` пустые у большинства документов, а `NULL NOT IN (...)`
     * в SQL не истина, и такой документ вылетел бы из списка ни за что.
     */
    private static function hide($q, array $hidden, array $columns)
    {
        if (!$hidden) return $q;

        foreach ($columns as $c) {
            $q->where(fn ($w) => $w->whereNull($c)->orWhereNotIn($c, $hidden));
        }

        return $q;
    }

    private static function has(string $db, string $table): bool
    {
        return Schema::connection($db)->hasTable($table);
    }

    /**
     * Название вида документа по его коду.
     *
     * В `documents.type` лежит код (`incoming_invoice`), а человеку нужна
     * «Приходная накладная». Виды документов — десяток строк на базу, поэтому
     * читаем их один раз за запрос, а не джойном к каждой строке.
     */
    private static function docType(string $db, ?string $code): string
    {
        static $names = [];

        if (!array_key_exists($db, $names)) {
            $names[$db] = self::has($db, 'document_types')
                ? DB::connection($db)->table('document_types')->pluck('name', 'code')->all()
                : [];
        }

        return $names[$db][$code] ?? ($code ?: 'документ');
    }

    private static function money($v): string
    {
        return self::num($v) . ' ₽';
    }

    private static function num($v): string
    {
        return number_format((float) $v, 2, ',', ' ');
    }

    private static function day($v): string
    {
        return $v ? implode('.', array_reverse(explode('-', substr((string) $v, 0, 10)))) : '—';
    }

    private static function month($v): string
    {
        $s = substr((string) $v, 0, 7);

        return $s ? implode('.', array_reverse(explode('-', $s))) : '—';
    }
}
