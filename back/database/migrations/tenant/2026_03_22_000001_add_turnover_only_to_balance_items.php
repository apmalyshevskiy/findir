<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // 1. Добавляем три флага — по одному на каждый слот аналитики
        Schema::table('balance_items', function (Blueprint $table) {
            $table->boolean('info_1_turnover_only')->default(false)->after('info_1_type')
                ->comment('Аналитика 1-го слота показывается только оборотами (без сальдо)');
            $table->boolean('info_2_turnover_only')->default(false)->after('info_2_type')
                ->comment('Аналитика 2-го слота показывается только оборотами (без сальдо)');
            $table->boolean('info_3_turnover_only')->default(false)->after('info_3_type')
                ->comment('Аналитика 3-го слота показывается только оборотами (без сальдо)');
        });

        // 2. Проставляем флаги для стандартных счетов
        //
        // А100 ДЕНЕЖНЫЕ СРЕДСТВА: info_1=cash (остатки нужны), info_2=flow (только обороты)
        DB::table('balance_items')->where('code', 'А100')
            ->update(['info_2_turnover_only' => true]);

        // П587 ДОХОДЫ: info_1=revenue, info_2=product — оба только обороты
        DB::table('balance_items')->where('code', 'П587')
            ->update(['info_1_turnover_only' => true, 'info_2_turnover_only' => true]);

        // П588 СЕБЕСТОИМОСТЬ: info_1=revenue, info_2=product — оба только обороты
        DB::table('balance_items')->where('code', 'П588')
            ->update(['info_1_turnover_only' => true, 'info_2_turnover_only' => true]);

        // П589 РАСХОДЫ: info_1=expenses — только обороты
        DB::table('balance_items')->where('code', 'П589')
            ->update(['info_1_turnover_only' => true]);
    }

    public function down(): void
    {
        Schema::table('balance_items', function (Blueprint $table) {
            $table->dropColumn(['info_1_turnover_only', 'info_2_turnover_only', 'info_3_turnover_only']);
        });
    }
};
