<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * КЛИЕНТЫ: А405 → А300.
 *
 * Код счёта — то, что человек видит в оборотке и в карте разноски, и А405
 * выбивался из ряда: у остальных активов сотни, а этот застрял в четырёхсотых
 * с давних пор.
 *
 * Через миграцию, а не через интерфейс, потому что смена кода у счёта, занятого
 * в карте разноски, там запрещена — и правильно: по отдельности это оторвало бы
 * разноску от счёта. Здесь обе стороны меняются разом.
 *
 * Операции не трогаем: они ссылаются на счёт по id, а id остаётся прежним.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Если А300 уже есть (база создана после смены каталога) — переносить
        // нечего, а слить два счёта в один молча мы не вправе
        if (DB::table('balance_items')->where('code', 'А300')->exists()) {
            return;
        }

        DB::transaction(function () {
            $renamed = DB::table('balance_items')->where('code', 'А405')->update(['code' => 'А300']);

            if ($renamed) {
                DB::table('category_postings')
                    ->where('counter_account_code', 'А405')
                    ->update(['counter_account_code' => 'А300']);
            }
        });
    }

    public function down(): void
    {
        DB::transaction(function () {
            DB::table('balance_items')->where('code', 'А300')->update(['code' => 'А405']);
            DB::table('category_postings')
                ->where('counter_account_code', 'А300')
                ->update(['counter_account_code' => 'А405']);
        });
    }
};
