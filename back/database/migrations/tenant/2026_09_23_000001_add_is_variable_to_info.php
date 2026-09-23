<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Отметка «переменная» у статьи расхода.
 *
 * Нужна варианту БДР, который делит расходы на переменные и постоянные:
 * заводить для этого второй счёт или второе дерево статей не пришлось —
 * статьи те же, меняется только то, в какую половину отчёта они попадают.
 *
 * Колонка общая для всей таблицы, но смысл имеет только у type = expenses:
 * у контрагента или кассы «переменности» не бывает. Отдельной таблицы ради
 * одного флага не заводим — в info так же живёт default_expense_id, который
 * тоже касается не всех типов.
 *
 * Умолчание — «постоянная». Так сегодняшние справочники не меняют поведения:
 * пока человек ничего не отметил, все расходы постоянные, и разделённый БДР
 * показывает то же, что обычный.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('info', function (Blueprint $table) {
            $table->boolean('is_variable')->default(false)->after('is_active');
        });
    }

    public function down(): void
    {
        Schema::table('info', function (Blueprint $table) {
            $table->dropColumn('is_variable');
        });
    }
};
