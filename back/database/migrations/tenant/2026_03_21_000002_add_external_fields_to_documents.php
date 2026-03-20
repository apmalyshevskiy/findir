<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            // Внешний номер и дата из исходной программы (1С, ERP и т.д.)
            $table->string('external_number', 100)->nullable()->after('number');
            $table->date('external_date')->nullable()->after('external_number');

            // Меняем date с date на datetime чтобы хранить время операции
            $table->datetime('date')->change();
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn('external_number');
            $table->dropColumn('external_date');
            $table->date('date')->change();
        });
    }
};
