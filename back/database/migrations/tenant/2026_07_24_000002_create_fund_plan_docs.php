<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Акт финансового планирования (документ на неделю + модель)
        Schema::create('fund_plan_docs', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('scheme_id');
            $table->date('week_start');
            $table->string('status', 20)->default('draft');   // draft | approved
            $table->string('note')->nullable();
            $table->unsignedBigInteger('created_by')->nullable();
            $table->timestamps();
            $table->softDeletes();
            $table->index(['scheme_id', 'week_start']);
        });

        // Строки акта: планируемый расход по фонду с расшифровкой (статья ДДС + сумма + комментарий)
        Schema::create('fund_plan_lines', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('doc_id')->index();
            $table->unsignedBigInteger('fund_id');
            $table->unsignedBigInteger('flow_info_id')->nullable();
            $table->decimal('amount', 15, 2)->default(0);
            $table->string('comment')->nullable();
            $table->integer('sort_order')->default(0);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('fund_plan_lines');
        Schema::dropIfExists('fund_plan_docs');
    }
};
