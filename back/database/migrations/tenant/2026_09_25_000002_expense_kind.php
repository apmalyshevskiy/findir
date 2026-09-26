<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Вид статьи расхода: постоянная, переменная, инвестиционная.
 *
 * Было `is_variable` — флажок на две половины. Инвестиции третьим состоянием
 * во флажок не помещаются, а второй флажок рядом допускал бы бессмыслицу
 * «переменная и инвестиционная одновременно». Поэтому одна колонка со списком
 * значений: их всегда взаимоисключающий набор, и следующий вид (скажем,
 * «разовые») добавится сюда же, а не третьим флажком.
 *
 * Не enum: значения тут прикладные, а не структурные, и расширять их миграцией
 * схемы каждый раз незачем — ровно та же причина, по которой типы слотов
 * аналитики переехали в varchar. Проверку делает контроллер.
 *
 * Перенос: `is_variable = 1` → `variable`, остальное → `fixed`. Умолчание
 * прежнее — постоянная, так что отчёт у тех, кто ничего не отмечал, не
 * меняется.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('info', function (Blueprint $table) {
            $table->string('expense_kind', 20)->default('fixed')->after('is_variable');
        });

        DB::connection(Schema::getConnection()->getName())->table('info')
            ->where('is_variable', true)
            ->update(['expense_kind' => 'variable']);

        Schema::table('info', function (Blueprint $table) {
            $table->dropColumn('is_variable');
        });
    }

    public function down(): void
    {
        Schema::table('info', function (Blueprint $table) {
            $table->boolean('is_variable')->default(false)->after('is_active');
        });

        DB::connection(Schema::getConnection()->getName())->table('info')
            ->where('expense_kind', 'variable')
            ->update(['is_variable' => true]);

        Schema::table('info', function (Blueprint $table) {
            $table->dropColumn('expense_kind');
        });
    }
};
