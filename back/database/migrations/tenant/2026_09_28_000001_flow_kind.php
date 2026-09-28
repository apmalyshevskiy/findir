<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Вид деятельности у статьи ДДС: операционная, инвестиционная, финансовая.
 *
 * Нужен ОДДС: отчёт раскладывает движение денег на три раздела и по каждому
 * считает чистый поток. Без разметки отчёт был бы просто списком статей, а
 * вопрос «мы проели деньги или вложили их» остался бы без ответа.
 *
 * Колонка общая для всей таблицы, но смысл имеет только у type = flow — ровно
 * как expense_kind у статей расхода, и лежит рядом с ним по той же причине:
 * отдельная таблица ради одного поля не окупается.
 *
 * Умолчание — операционная. Так сегодняшние справочники не меняют поведения:
 * пока человек ничего не проставил, весь поток операционный, и это верно для
 * подавляющего большинства статей.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('info', function (Blueprint $table) {
            $table->string('flow_kind', 20)->default('operating')->after('expense_kind');
        });
    }

    public function down(): void
    {
        Schema::table('info', function (Blueprint $table) {
            $table->dropColumn('flow_kind');
        });
    }
};
