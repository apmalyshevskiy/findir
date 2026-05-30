<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Карта разноски (ступень 2): категория платежа → счёт + статья ДДС.
 *
 * Одна строка на категорию. Счёт хранится ПО КОДУ (коды плана счетов общие
 * для всех тенантов), статья ДДС — по id (она у каждого тенанта своя).
 * Тенант может переопределить и счёт, и статью, не трогая код приложения.
 *
 * Тенантная миграция: применяется через `php artisan tenants:migrate`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('category_postings', function (Blueprint $table) {
            $table->id();

            // Категория из App\Services\PaymentCategory (TRANSFER, TAX, …)
            $table->string('category', 40)->unique();

            // Корр-счёт по КОДУ плана счетов (А100, П589, П340 …). Nullable —
            // у TRANSFER корр-счёт = А100 для обеих ног, задаётся правилом.
            $table->string('counter_account_code', 35)->nullable();

            // Статья ДДС (info.type=flow) по умолчанию для этой категории.
            // Nullable: правило классификации может пин-ить статью точнее
            // (например TAX → «ЗП налоги» по назначению), тогда дефолт не нужен.
            $table->unsignedBigInteger('flow_info_id')->nullable();

            // Как заполнять контрагента: 'from_inn' (искать партнёра по ИНН) | 'none'
            $table->string('partner_mode', 16)->default('from_inn');

            $table->boolean('is_active')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('category_postings');
    }
};
