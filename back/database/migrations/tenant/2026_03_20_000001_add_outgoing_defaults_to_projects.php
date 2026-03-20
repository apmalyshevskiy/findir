<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('projects', function (Blueprint $table) {
            // Дефолты для outgoing_invoice.
            // Копируются в документ при создании и фиксируются навсегда.
            $table->unsignedBigInteger('outgoing_revenue_bi_id')->nullable()->after('timezone');
            $table->unsignedBigInteger('outgoing_cogs_bi_id')->nullable()->after('outgoing_revenue_bi_id');
            $table->unsignedBigInteger('outgoing_revenue_item_id')->nullable()->after('outgoing_cogs_bi_id');
        });
    }

    public function down(): void
    {
        Schema::table('projects', function (Blueprint $table) {
            $table->dropColumn([
                'outgoing_revenue_bi_id',
                'outgoing_cogs_bi_id',
                'outgoing_revenue_item_id',
            ]);
        });
    }
};
