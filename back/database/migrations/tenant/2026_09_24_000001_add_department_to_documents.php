<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Отдел документа.
 *
 * Розничная смена целиком принадлежит одной точке продаж, а точка — одному
 * отделу. Разрез по отделам при этом нужен не в строках, а в проводках: и
 * выручка, и себестоимость, и налог должны лечь с отделом, хотя строка в
 * документе одна. Поэтому отдел живёт в шапке, а не в строке.
 *
 * В слот аналитики он попадает не всегда, а только там, где счёт сам объявил
 * слот под справочник «Отделы» — см. OutgoingInvoiceStrategy. Счёт без такого
 * слота ведёт себя как прежде.
 *
 * Стиль колонки повторяет info_1_id шапки: знаковый bigInteger, nullable, без
 * внешнего ключа — справочник живёт в той же базе, но ссылки на него везде
 * мягкие.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->bigInteger('department_id')->nullable()->after('info_3_id');
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn('department_id');
        });
    }
};
