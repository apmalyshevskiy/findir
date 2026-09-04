<?php

use Database\Seeders\DocumentTypesSeeder;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Корреспондирующая сторона в строке документа.
 *
 * Раньше вторая сторона проводки была одна на весь документ — та, что в шапке.
 * На первом же авансовом отчёте это сломалось: отчитывается сотрудник через
 * свою кассу (А100), касса на весь документ одна, а статья ДДС у каждой строки
 * своя — часть денег ушла по статье «ЗП», часть по «Закупкам».
 *
 * Поэтому строка получает право переопределить корреспондирующую сторону: и её
 * аналитику, и сам счёт. Пусто в строке означает «как в шапке» — так документы,
 * где переопределять нечего, остаются прежними.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('document_items', function (Blueprint $table) {
            $table->unsignedBigInteger('head_bi_id')->nullable()->after('info_3_id');
            $table->unsignedBigInteger('head_info_1_id')->nullable()->after('head_bi_id');
            $table->unsignedBigInteger('head_info_2_id')->nullable()->after('head_info_1_id');
            $table->unsignedBigInteger('head_info_3_id')->nullable()->after('head_info_2_id');
        });

        Schema::table('document_types', function (Blueprint $table) {
            // Что вид выносит в строку отдельной колонкой: ["info_2"] — статья
            // ДДС у каждой строки своя. Остальное всё равно можно переопределить
            // в раскрывающейся панели строки, здесь только вопрос удобства
            $table->json('line_head_fields')->nullable()->after('show_vat');
        });

        // Виды, которых на базе ещё нет: на новых тенантах прошлая миграция
        // пропускала вставку, пока не заведён план счетов
        DocumentTypesSeeder::seedOn();

        // Авансовый отчёт переезжает на кассу сотрудника. Трогаем только те
        // строки, что дословно совпадают с прежней заводской настройкой:
        // если тенант успел поправить вид под себя, это его настройка,
        // и переписывать её мы не вправе
        $accounts = DB::table('balance_items')->pluck('id', 'code');
        $old = ['head' => $accounts['П335'] ?? null, 'item' => $accounts['П589'] ?? null];
        $new = ['head' => $accounts['А100'] ?? null];

        if ($old['head'] && $old['item'] && $new['head']) {
            DB::table('document_types')
                ->where('code', 'expense_report')
                ->where('head_bi_id', $old['head'])
                ->where('item_bi_id', $old['item'])
                ->where('head_side', 'credit')
                ->whereNull('line_head_fields')
                ->update([
                    'head_bi_id'       => $new['head'],
                    'line_head_fields' => json_encode(['info_2']),
                    'updated_at'       => now(),
                ]);
        }
    }

    public function down(): void
    {
        Schema::table('document_items', function (Blueprint $table) {
            $table->dropColumn(['head_bi_id', 'head_info_1_id', 'head_info_2_id', 'head_info_3_id']);
        });

        Schema::table('document_types', function (Blueprint $table) {
            $table->dropColumn('line_head_fields');
        });
    }
};
