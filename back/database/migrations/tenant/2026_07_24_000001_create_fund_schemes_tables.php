<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Модель распределения (набор фондов с процентами)
        Schema::create('fund_schemes', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('note')->nullable();
            $table->unsignedTinyInteger('week_start_dow')->default(5); // 5 = пятница
            $table->date('start_date')->nullable();                   // дата начала учёта фондов
            $table->json('income_flow_ids')->nullable();              // статьи ДДС поступлений
            $table->boolean('is_active')->default(true);
            $table->timestamps();
            $table->softDeletes();
        });

        // Фонды внутри модели
        Schema::create('funds', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('scheme_id')->index();
            $table->string('name');
            $table->decimal('percent', 6, 2)->default(0);
            $table->json('flow_info_ids')->nullable();      // привязанные статьи ДДС (расход)
            $table->decimal('opening_balance', 15, 2)->default(0);
            $table->integer('sort_order')->default(0);
            $table->timestamps();
            $table->softDeletes();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('funds');
        Schema::dropIfExists('fund_schemes');
    }
};
