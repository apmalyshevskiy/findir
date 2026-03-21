<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('budget_documents', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->enum('type', ['dds', 'bdr'])->default('dds');
            $table->date('period_from');
            $table->date('period_to');
            $table->unsignedBigInteger('project_id');
            $table->enum('status', ['draft', 'approved'])->default('draft');
            $table->unsignedBigInteger('created_by')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['project_id', 'type']);
        });

        Schema::create('budget_items', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('budget_document_id');
            $table->unsignedBigInteger('article_id');       // → info.id (flow для ДДС, revenue/expenses для БДР)
            $table->unsignedBigInteger('cash_id')->nullable(); // → info.id (type=cash), только для ДДС
            $table->date('period_date');                      // начало периода (1-е число месяца, или понедельник недели)
            $table->decimal('amount', 15, 2)->default(0);
            $table->timestamps();

            $table->foreign('budget_document_id')
                  ->references('id')->on('budget_documents')
                  ->cascadeOnDelete();

            $table->unique(['budget_document_id', 'article_id', 'cash_id', 'period_date'], 'budget_items_unique');
            $table->index('article_id');
        });

        Schema::create('budget_opening_balances', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('budget_document_id');
            $table->unsignedBigInteger('cash_id')->nullable(); // → info.id (type=cash), null = общая сумма
            $table->decimal('amount', 15, 2)->default(0);
            $table->boolean('is_manual')->default(false);
            $table->timestamps();

            $table->foreign('budget_document_id')
                  ->references('id')->on('budget_documents')
                  ->cascadeOnDelete();

            $table->unique(['budget_document_id', 'cash_id'], 'budget_opening_unique');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('budget_opening_balances');
        Schema::dropIfExists('budget_items');
        Schema::dropIfExists('budget_documents');
    }
};
