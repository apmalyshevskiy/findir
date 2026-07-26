<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('fund_plan_lines', function (Blueprint $table) {
            $table->boolean('accepted')->default(true)->after('comment');
        });
    }

    public function down(): void
    {
        Schema::table('fund_plan_lines', function (Blueprint $table) {
            $table->dropColumn('accepted');
        });
    }
};
