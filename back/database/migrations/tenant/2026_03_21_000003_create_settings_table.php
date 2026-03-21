<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Универсальная таблица настроек тенанта (key-value)
        Schema::create('settings', function (Blueprint $table) {
            $table->string('key', 100)->primary();
            $table->text('value')->nullable();
            $table->timestamps();
        });

        // balance_actual_date — дата до которой (включительно) таблица balance
        // содержит актуальные агрегированные остатки.
        // Пока пустая — CostCalculatorService будет считать только из balance_changes.
        // DB::table('settings')->insert([
        //     'key'        => 'balance_actual_date',
        //     'value'      => null,
        //     'created_at' => now(),
        //     'updated_at' => now(),
        // ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('settings');
    }
};
