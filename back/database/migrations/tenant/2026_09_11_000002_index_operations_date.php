<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Индекс под главный запрос журнала операций.
 *
 * Журнал всегда отбирает по периоду и сортирует по дате и номеру, а индексы по
 * дате были только в паре с проектом — и не использовались, потому что проект в
 * отборе чаще всего не задан. На тысяче операций это незаметно, на сотне тысяч
 * каждое открытие списка читало бы таблицу целиком и сортировало результат.
 *
 * Порядок колонок повторяет ORDER BY: по такому индексу база берёт уже
 * отсортированные строки и останавливается, набрав страницу.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('operations', function (Blueprint $table) {
            $table->index(['date', 'id'], 'operations_date_id_index');
        });
    }

    public function down(): void
    {
        Schema::table('operations', function (Blueprint $table) {
            $table->dropIndex('operations_date_id_index');
        });
    }
};
