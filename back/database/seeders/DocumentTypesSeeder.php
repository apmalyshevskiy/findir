<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Виды документов — стартовый набор.
 *
 * Вид документа описывает, во что превращается документ при проведении: счёт и
 * сторона шапки, счёт строк, какие колонки показывать. Само проведение одно на
 * все виды (UniversalStrategy), поэтому новый вид — это строка справочника,
 * а не новый класс.
 *
 * Набор заводится сразу, чтобы справочник не встречал пустым, и удаляется
 * целиком или по одному, если тенант такими документами не пользуется.
 *
 * Расходная накладная стоит особняком: у неё собственный движок в коде (выручка
 * и себестоимость — две операции на строку), поэтому она помечена системной.
 *
 * Зовётся из двух мест: из миграции — для существующих баз, и из
 * TenantDatabaseSeeder — для новых, где на момент миграций плана счетов ещё нет.
 * Оба раза вставка идёт по коду и повторный запуск ничего не портит.
 */
class DocumentTypesSeeder extends Seeder
{
    /**
     * Счета заданы кодами, а не идентификаторами: id плана счетов у тенантов
     * совпадают, но полагаться на это нельзя — код это то, что человек видит.
     */
    public static function presets(): array
    {
        return [
            [
                'code' => 'incoming_invoice', 'name' => 'Приходная накладная',
                'head_bi_code' => 'П100', 'head_side' => 'credit', 'item_bi_code' => 'А200',
                'show_quantity' => 1, 'show_price' => 1, 'show_vat' => 1,
                'engine' => 'universal', 'is_system' => 0, 'sort_order' => 10,
            ],
            [
                // Через кассу сотрудника, а не через расчёты с ним: сотрудник
                // отчитывается за выданные деньги, и движение денег видно сразу.
                // Статья ДДС у каждой строки своя — одна поездка по статье
                // «Прочее», закупка по «Закупкам», поэтому она уходит в строки
                'code' => 'expense_report', 'name' => 'Авансовый отчёт',
                'head_bi_code' => 'А100', 'head_side' => 'credit', 'item_bi_code' => 'П589',
                'show_quantity' => 0, 'show_price' => 0, 'show_vat' => 0,
                'line_head_fields' => ['info_2'],
                'engine' => 'universal', 'is_system' => 0, 'sort_order' => 20,
            ],
            [
                'code' => 'payroll', 'name' => 'Начисление ЗП',
                'head_bi_code' => 'П589', 'head_side' => 'debit', 'item_bi_code' => 'П335',
                'show_quantity' => 0, 'show_price' => 0, 'show_vat' => 0,
                'engine' => 'universal', 'is_system' => 0, 'sort_order' => 30,
            ],
            [
                'code' => 'outgoing_invoice', 'name' => 'Расходная накладная',
                'head_bi_code' => 'А300', 'head_side' => 'debit', 'item_bi_code' => 'А200',
                'show_quantity' => 1, 'show_price' => 1, 'show_vat' => 1,
                'engine' => 'outgoing_invoice', 'is_system' => 1, 'sort_order' => 40,
            ],
        ];
    }

    /**
     * Дозаполнить справочник на текущем соединении.
     *
     * Существующие коды не трогаем: счета и колонки тенант мог поменять под себя,
     * и повторная миграция не должна возвращать их к заводским.
     */
    public static function seedOn(?string $connection = null): void
    {
        $db     = $connection ? DB::connection($connection) : DB::connection();
        $schema = $db->getSchemaBuilder();

        if (!$schema->hasTable('document_types')) {
            return;
        }

        $accounts = $db->table('balance_items')->pluck('id', 'code');

        // На новой базе миграции идут раньше сидеров, и плана счетов ещё нет.
        // Молча вставить виды без счетов было бы хуже, чем не вставить вовсе:
        // сидер придёт следом и заполнить их будет уже нечем — коды-то заняты
        if ($accounts->isEmpty()) {
            return;
        }

        // Поля, появившиеся позже таблицы: сидер зовётся и из старой миграции,
        // когда колонки ещё нет
        $hasLineFields = $schema->hasColumn('document_types', 'line_head_fields');

        $existing = $db->table('document_types')->pluck('code')->all();
        $now      = now();

        foreach (self::presets() as $preset) {
            if (in_array($preset['code'], $existing, true)) {
                continue;
            }

            $row = [
                'code'          => $preset['code'],
                'name'          => $preset['name'],
                'head_bi_id'    => $accounts[$preset['head_bi_code']] ?? null,
                'head_side'     => $preset['head_side'],
                'item_bi_id'    => $accounts[$preset['item_bi_code']] ?? null,
                'show_quantity' => $preset['show_quantity'],
                'show_price'    => $preset['show_price'],
                'show_vat'      => $preset['show_vat'],
                'engine'        => $preset['engine'],
                'is_system'     => $preset['is_system'],
                'is_active'     => 1,
                'sort_order'    => $preset['sort_order'],
                'created_at'    => $now,
                'updated_at'    => $now,
            ];

            if ($hasLineFields && isset($preset['line_head_fields'])) {
                $row['line_head_fields'] = json_encode($preset['line_head_fields']);
            }

            $db->table('document_types')->insert($row);
        }
    }

    public function run(): void
    {
        self::seedOn();
    }
}
