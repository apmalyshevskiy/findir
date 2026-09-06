<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Закрытые счета у должности.
 *
 * Права по разделам открывают раздел целиком: разрешил «Операции» — человек
 * видит и выплаты зарплаты, и расчёты с учредителем. Здесь появляется поперечный
 * разрез — список счетов, которые должность не видит нигде: ни в операциях, ни
 * в документах, ни в отчётах.
 *
 * Значений не проставляем: null и пустой массив означают «ничего не закрыто» —
 * ровно сегодняшнее поведение, поэтому существующие должности не меняются.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('roles', function (Blueprint $table) {
            // Массив bi_id. Хранится то, что отметили; потомки закрытого счёта
            // раскрываются при чтении — иначе новый подчинённый счёт оказался
            // бы открытым
            $table->json('denied_accounts')->nullable()->after('permissions');
        });
    }

    public function down(): void
    {
        Schema::table('roles', function (Blueprint $table) {
            $table->dropColumn('denied_accounts');
        });
    }
};
