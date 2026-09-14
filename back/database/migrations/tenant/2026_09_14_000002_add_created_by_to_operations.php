<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Автор операции.
 *
 * У документа такая колонка была с самого начала, у операции — нет, и вопрос
 * «кто это внёс» до сих пор оставался без ответа. Журнал изменений отвечает на
 * него только для записанного с его появления и только запросом в другую
 * таблицу: показать автора в списке из двух сотен строк это подзапрос на
 * каждую строку, а отобрать «что внёс Иванов» — и вовсе неудобно.
 *
 * Пары `updated_by` намеренно нет: «кто правил последним» — это верхняя строка
 * журнала, и вторая копия того же факта однажды разойдётся с ним и соврёт.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('operations', function (Blueprint $table) {
            $table->unsignedBigInteger('created_by')->nullable()->after('source');
            $table->index('created_by');
        });

        // Операции, рождённые проведением документа, вставляются построителем
        // запросов — ни события модели, ни журнала у них нет. Зато у документа
        // автор есть, и он же автор его операций: это единственные записи,
        // которым автора можно проставить задним числом не выдумывая
        DB::statement("
            UPDATE operations o
              JOIN documents d ON o.table_name = 'documents' AND o.table_id = CAST(d.id AS CHAR)
               SET o.created_by = d.created_by
             WHERE o.created_by IS NULL AND d.created_by IS NOT NULL
        ");
    }

    public function down(): void
    {
        Schema::table('operations', function (Blueprint $table) {
            $table->dropIndex(['created_by']);
            $table->dropColumn('created_by');
        });
    }
};
