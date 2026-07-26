<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('fund_plan_docs', function (Blueprint $table) {
            // Локальное переопределение процентов распределения по фондам: {fund_id: percent}
            $table->json('fund_percents')->nullable()->after('note');
        });
    }

    public function down(): void
    {
        Schema::table('fund_plan_docs', function (Blueprint $table) {
            $table->dropColumn('fund_percents');
        });
    }
};
