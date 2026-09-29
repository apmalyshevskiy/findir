<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/**
 * Кто ссылается на элемент справочника.
 *
 * Нужно там, где элемент меняет природу или исчезает: сменить справочник у
 * элемента, на который уже сослались операции, — значит переписать прошлое.
 * Контрагент, ставший статьёй расхода, не исчезает из проводок: он остаётся
 * в слоте, объявленном под контрагентов, и отчёты начинают показывать статью
 * там, где ждали контрагента.
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

    /**
     * Где встречается элемент: место → сколько строк. Пустые места опускаем.
     *
     * @return array<string, int>
     */
    public static function count(string $db, int $id): array
    {
        $out = [];

        foreach (self::COLUMNS as $table => $columns) {
            if (!DB::connection($db)->getSchemaBuilder()->hasTable($table)) continue;

            $q = DB::connection($db)->table($table)
                ->where(function ($w) use ($columns, $id) {
                    foreach ($columns as $c) $w->orWhere($c, $id);
                });

            // Удалённое не считаем ссылкой: оно уже не участвует ни в отчётах,
            // ни в проводках, и держать из-за него элемент незачем
            if (DB::connection($db)->getSchemaBuilder()->hasColumn($table, 'deleted_at')) {
                $q->whereNull('deleted_at');
            }

            // Сам себя элемент не держит: info.parent_id = свой же id быть не
            // может, но default_expense_id на себя — вполне
            if ($table === 'info') $q->where('id', '!=', $id);

            $n = $q->count();
            if ($n) $out[$table] = $n;
        }

        foreach (self::JSON_LISTS as $table => $column) {
            if (!DB::connection($db)->getSchemaBuilder()->hasTable($table)) continue;

            $n = 0;
            foreach (DB::connection($db)->table($table)->whereNull('deleted_at')->pluck($column) as $raw) {
                $ids = json_decode((string) $raw, true);
                if (is_array($ids) && in_array($id, array_map('intval', $ids), true)) $n++;
            }
            if ($n) $out[$table] = $n;
        }

        if (DB::connection($db)->getSchemaBuilder()->hasTable('integration_links')) {
            $n = DB::connection($db)->table('integration_links')
                ->where('local_type', 'info')->where('local_id', $id)->count();
            if ($n) $out['integration_links'] = $n;
        }

        return $out;
    }

    /** Есть ли хоть одна ссылка */
    public static function any(string $db, int $id): bool
    {
        return self::count($db, $id) !== [];
    }

    /** «12 операций, 3 документа» — для сообщения об отказе */
    public static function describe(array $counts): string
    {
        $parts = [];
        foreach ($counts as $table => $n) {
            $parts[] = $n . ' — ' . (self::LABELS[$table] ?? $table);
        }

        return implode(', ', $parts);
    }
}
