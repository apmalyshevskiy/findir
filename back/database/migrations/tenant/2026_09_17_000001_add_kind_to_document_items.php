<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Вид строки документа.
 *
 * До сих пор все строки означали одно и то же — что продали или что купили.
 * Розничная смена так не описывается: кроме выручки и себестоимости в ней есть
 * оплаты (сколько закрыли картой, сколько наличными) и налог. Это тоже строки
 * документа — повторяющаяся часть, которых бывает сколько угодно, — но
 * проводятся они иначе.
 *
 * Отдельная колонка, а не догадка по счёту: счёт А300 стоит и в выручке, и в
 * безналичной оплате, и различить их можно только намерением, а не данными.
 *
 * `sale` по умолчанию — все существующие строки остаются тем, чем были.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('document_items', function (Blueprint $table) {
            $table->string('kind', 16)->default('sale')->after('sort_order');
        });
    }

    public function down(): void
    {
        Schema::table('document_items', function (Blueprint $table) {
            $table->dropColumn('kind');
        });
    }
};
