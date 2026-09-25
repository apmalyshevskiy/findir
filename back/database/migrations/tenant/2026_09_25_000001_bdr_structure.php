<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Настраиваемая структура БДР.
 *
 * Раньше разрез был один и зашит в код: доходы и себестоимость по статьям
 * дохода, расходы по статьям расходов. Теперь каждый раздел отчёта может
 * раскладываться на несколько уровней — «Отделы → Статьи», «Отделы» в
 * одиночку, «Номенклатура» вместо статьи дохода, — и у каждого бюджета свой.
 *
 * `structure` — на документе, а не в общих настройках: план привязан к своему
 * бюджету, и смена разреза не должна задевать соседние. Заодно два бюджета с
 * разными разрезами можно держать рядом и сравнивать.
 *
 * Формат: раздел → список видов справочника по уровням.
 *   {"revenue":["department","revenue"],"cost":["revenue"],"expenses":["department","expenses"]}
 * Пусто (null) — разрез берётся из самого счёта: какие слоты аналитики он
 * объявил, те и уровни. Так старые бюджеты продолжают показывать прежнее.
 *
 * У строки плана появляются второй и третий уровни. Существующие строки
 * остаются одноуровневыми — id второго и третьего уровня у них пусты, и это
 * ровно то же, чем они были.
 *
 * Уникальный ключ не трогаем намеренно: у строк БДР `cash_id` пуст, а MySQL
 * считает NULL-ы различными, так что ограничение на них и раньше не
 * действовало — несколько строк плана в одной ячейке это штатный случай,
 * у каждой свой комментарий.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('budget_documents', function (Blueprint $table) {
            $table->json('structure')->nullable()->after('status');
        });

        Schema::table('budget_items', function (Blueprint $table) {
            $table->unsignedBigInteger('article_2_id')->nullable()->after('article_id');
            $table->unsignedBigInteger('article_3_id')->nullable()->after('article_2_id');

            $table->index(['budget_document_id', 'article_2_id'], 'budget_items_lvl2');
        });
    }

    public function down(): void
    {
        Schema::table('budget_items', function (Blueprint $table) {
            $table->dropIndex('budget_items_lvl2');
            $table->dropColumn(['article_2_id', 'article_3_id']);
        });

        Schema::table('budget_documents', function (Blueprint $table) {
            $table->dropColumn('structure');
        });
    }
};
