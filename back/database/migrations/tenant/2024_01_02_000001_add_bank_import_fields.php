<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('operations', function (Blueprint $table) {
            if (!Schema::hasColumn('operations', 'external_id')) {
            $table->string('external_id', 25)->nullable()->after('source');
            }

            $table->date('external_date')->nullable()->after('external_id');

            $table->index(['source', 'external_id', 'external_date'], 'idx_operations_external');
        });

        Schema::table('info', function (Blueprint $table) {
            $table->string('inn', 12)->nullable()->after('description');
            $table->index('inn', 'idx_info_inn');
        });
    }

    public function down(): void
    {
        Schema::table('operations', function (Blueprint $table) {
            $table->dropIndex('idx_operations_external');
            $table->dropColumn(['external_id', 'external_date']);
        });

        Schema::table('info', function (Blueprint $table) {
            $table->dropIndex('idx_info_inn');
            $table->dropColumn('inn');
        });
    }
};