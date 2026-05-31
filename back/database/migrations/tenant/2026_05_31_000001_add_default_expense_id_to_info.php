<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('info', function (Blueprint $table) {
            // Статья расхода по умолчанию (Вариант 1).
            // Self-reference на info.id записи типа 'expenses', связь 1:1.
            // Стиль колонки повторяет parent_id: знаковый bigInteger, nullable,
            // с индексом, без жёсткого FK.
            $table->bigInteger('default_expense_id')->nullable()->index()->after('inn');
        });
    }

    public function down(): void
    {
        Schema::table('info', function (Blueprint $table) {
            $table->dropIndex(['default_expense_id']); // info_default_expense_id_index
            $table->dropColumn('default_expense_id');
        });
    }
};
