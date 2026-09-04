<?php

namespace Database\Seeders;

use App\Services\ChartOfAccounts;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Стартовый план счетов тенанта.
 *
 * Создаём не весь каталог, а только заводские счета — те, без которых учёт не
 * начать. Остальное тенант добавляет из списка по мере надобности:
 * см. App\Services\ChartOfAccounts и «План счетов → Добавить из списка».
 *
 * Идентификаторы задаём явно и теми же, что в каталоге: по ним счета совпадают
 * между базами, а добавление из списка потом кладёт счёт на его законное место.
 */
class BalanceItemsSeeder extends Seeder
{
    public function run(): void
    {
        $now  = now();
        $rows = [];

        foreach (ChartOfAccounts::defaults() as $account) {
            $rows[] = ChartOfAccounts::toRow($account, self::defaultIdsByCode()) + [
                'id'         => $account['id'],
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        DB::table('balance_items')->insertOrIgnore($rows);
    }

    /**
     * Коды → id для разрешения родителей.
     *
     * На пустой базе id заводских счетов известны заранее, поэтому родителя
     * можно проставить сразу, одной вставкой.
     */
    private static function defaultIdsByCode(): array
    {
        $map = [];
        foreach (ChartOfAccounts::defaults() as $account) {
            $map[$account['code']] = $account['id'];
        }
        return $map;
    }
}
