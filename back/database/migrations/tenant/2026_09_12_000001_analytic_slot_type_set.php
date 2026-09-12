<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Слот аналитики хранит набор типов, а не один тип.
 *
 * Было: enum на восемь значений — счёт объявлял в слоте ровно один справочник.
 * Стало: строка, в которой лежит либо один тип, либо несколько через запятую,
 * либо слово `any` — любой справочник. См. App\Services\AnalyticSlots.
 *
 * Данные не трогаем: сегодняшнее одиночное значение читается как набор из
 * одного, и ни один настроенный счёт не меняет поведения. Enum расширять не
 * стали — список допустимых значений всё равно проверяет контроллер, а каждый
 * следующий тип требовал бы новой миграции.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('balance_items', function (Blueprint $table) {
            // 100 символов хватает на все восемь типов через запятую с запасом
            $table->string('info_1_type', 100)->nullable()->change();
            $table->string('info_2_type', 100)->nullable()->change();
            $table->string('info_3_type', 100)->nullable()->change();
        });
    }

    public function down(): void
    {
        // Назад в enum не возвращаем: счета с набором или «любым» такой откат
        // обнулил бы молча
    }
};
