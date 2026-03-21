<?php

namespace App\Services\Documents;

use Illuminate\Support\Facades\DB;

/**
 * CostCalculatorService — расчёт себестоимости по методу средневзвешенной цены.
 *
 * Используется в:
 *   - OutgoingInvoiceStrategy (расходная накладная)
 *   - В будущем: Списание, Перемещение, Производство
 *
 * Алгоритм:
 *   1. Проверяем настройку balance_actual_date в таблице settings.
 *   2. Если дата актуальности D существует:
 *        opening_amount   = SUM(amount)   из balance   WHERE ... AND date <= D
 *        opening_quantity = SUM(quantity) из balance   WHERE ... AND date <= D
 *        delta_amount     = SUM(amount)   из balance_changes WHERE ... AND date > D AND date < doc_date
 *        delta_quantity   = SUM(quantity) из balance_changes WHERE ... AND date > D AND date < doc_date
 *      Иначе — только из balance_changes WHERE date < doc_date.
 *   3. Цена за единицу = total_amount / total_quantity
 *   4. Себестоимость строки:
 *        qty >= stock_qty → берём всю сумму остатка
 *        qty <  stock_qty → qty * цена_за_единицу
 *   5. Если остаток <= 0 → amount_cost = 0, флаг negative_stock = true
 */
class CostCalculatorService
{
    /**
     * Рассчитать себестоимость для набора строк документа.
     *
     * @param string $dbName     Имя соединения с тенантной БД
     * @param string $docDate    Дата документа (Y-m-d H:i:s) — остаток считается СТРОГО ДО неё
     * @param int    $projectId
     * @param array  $items      Массив строк: [{bi_id, info_1_id, info_2_id, info_3_id, quantity}]
     *
     * @return array [{
     *   bi_id, info_1_id, info_2_id, info_3_id,
     *   stock_amount,    // сумма остатка
     *   stock_quantity,  // количество остатка
     *   unit_cost,       // цена за единицу
     *   amount_cost,     // рассчитанная себестоимость строки
     *   negative_stock,  // true если остаток <= 0
     * }]
     */
    public static function calculate(
        string $dbName,
        string $docDate,
        int    $projectId,
        array  $items
    ): array {
        if (empty($items)) {
            return [];
        }

        // ── 1. Читаем дату актуальности balance ───────────────────────────────
        // Таблица settings может не существовать — тогда считаем без неё
        $actualDate = null;
        try {
            $actualDate = DB::connection($dbName)
                ->table('settings')
                ->where('key', 'balance_actual_date')
                ->value('value');
        } catch (\Exception $e) {
            // settings таблица не создана — продолжаем без неё
            $actualDate = null;
        }

        // ── 2. Собираем уникальные ключи для batch-запроса ────────────────────
        // Группируем строки по (bi_id, info_1_id, info_2_id, info_3_id)
        // чтобы не делать N запросов а сделать один с GROUP BY
        $keys = collect($items)->map(fn($i) => [
            'bi_id'      => (int) $i['bi_id'],
            'info_1_id'  => (int) ($i['info_1_id'] ?? 0),
            'info_2_id'  => (int) ($i['info_2_id'] ?? 0),
            'info_3_id'  => (int) ($i['info_3_id'] ?? 0),
            'quantity'   => (float) $i['quantity'],
        ]);

        // ── 3. Получаем остатки ────────────────────────────────────────────────
        $stockMap = self::getStockMap($dbName, $projectId, $docDate, $actualDate, $keys->toArray());

        // ── 4. Рассчитываем себестоимость каждой строки ───────────────────────
        $results = [];
        foreach ($items as $item) {
            $biId     = (int) $item['bi_id'];
            $info1    = (int) ($item['info_1_id'] ?? 0);
            $info2    = (int) ($item['info_2_id'] ?? 0);
            $info3    = (int) ($item['info_3_id'] ?? 0);
            $qty      = (float) $item['quantity'];

            $mapKey = "{$biId}_{$info1}_{$info2}_{$info3}";
            $stock  = $stockMap[$mapKey] ?? ['amount' => 0, 'quantity' => 0];

            $stockAmt = (float) $stock['amount'];
            $stockQty = (float) $stock['quantity'];

            $negativeStock = $stockQty <= 0;
            $unitCost      = 0;
            $amountCost    = 0;

            if (!$negativeStock && $stockAmt > 0) {
                $unitCost = $stockAmt / $stockQty;

                if ($qty >= $stockQty) {
                    // Берём всю сумму остатка
                    $amountCost = $stockAmt;
                } else {
                    $amountCost = round($qty * $unitCost, 2);
                }
            }

            $results[] = [
                'bi_id'          => $biId,
                'info_1_id'      => $info1 ?: null,
                'info_2_id'      => $info2 ?: null,
                'info_3_id'      => $info3 ?: null,
                'quantity'       => $qty,
                'stock_amount'   => round($stockAmt, 2),
                'stock_quantity' => round($stockQty, 4),
                'unit_cost'      => round($unitCost, 4),
                'amount_cost'    => round($amountCost, 2),
                'negative_stock' => $negativeStock,
            ];
        }

        return $results;
    }

    /**
     * Получить остатки (amount, quantity) для набора позиций на дату.
     *
     * Возвращает map: "bi_id_info1_info2_info3" => {amount, quantity}
     */
    private static function getStockMap(
        string  $dbName,
        int     $projectId,
        string  $docDate,
        ?string $actualDate,
        array   $keys
    ): array {
        $map = [];

        // Собираем уникальные bi_id для WHERE IN
        $biIds = array_unique(array_column($keys, 'bi_id'));

        // ── Шаг А: остаток из таблицы balance (если есть актуальная дата) ─────
        $balanceRows = collect();
        if ($actualDate) {
            $balanceRows = DB::connection($dbName)
                ->table('balance')
                ->where('project_id', $projectId)
                ->whereIn('bi_id', $biIds)
                ->where('date', '<=', $actualDate)
                ->select(
                    'bi_id',
                    DB::raw('COALESCE(info_1_id, 0) as info_1_id'),
                    DB::raw('COALESCE(info_2_id, 0) as info_2_id'),
                    DB::raw('COALESCE(info_3_id, 0) as info_3_id'),
                    DB::raw('SUM(amount)   as amount'),
                    DB::raw('SUM(quantity) as quantity')
                )
                ->groupBy('bi_id', 'info_1_id', 'info_2_id', 'info_3_id')
                ->get();

            foreach ($balanceRows as $row) {
                $k = "{$row->bi_id}_{$row->info_1_id}_{$row->info_2_id}_{$row->info_3_id}";
                $map[$k] = [
                    'amount'   => (float) $row->amount,
                    'quantity' => (float) $row->quantity,
                ];
            }
        }

        // ── Шаг Б: дельта из balance_changes ──────────────────────────────────
        // quantity хранится со знаком (+ приход, - расход) только для счетов
        // с has_quantity=1. Для остальных счетов quantity=0.
        $changesQuery = DB::connection($dbName)
            ->table('balance_changes')
            ->where('project_id', $projectId)
            ->whereIn('bi_id', $biIds)
            ->where('date', '<', $docDate)
            ->select(
                'bi_id',
                DB::raw('COALESCE(info_1_id, 0) as info_1_id'),
                DB::raw('COALESCE(info_2_id, 0) as info_2_id'),
                DB::raw('COALESCE(info_3_id, 0) as info_3_id'),
                DB::raw('SUM(amount)   as amount'),
                DB::raw('SUM(quantity) as quantity')
            )
            ->groupBy('bi_id', 'info_1_id', 'info_2_id', 'info_3_id');

        if ($actualDate) {
            // Берём только то что ещё не учтено в balance
            $changesQuery->where('date', '>', $actualDate);
        }

        $changesRows = $changesQuery->get();

        foreach ($changesRows as $row) {
            $k = "{$row->bi_id}_{$row->info_1_id}_{$row->info_2_id}_{$row->info_3_id}";
            if (!isset($map[$k])) {
                $map[$k] = ['amount' => 0, 'quantity' => 0];
            }
            $map[$k]['amount']   += (float) $row->amount;
            $map[$k]['quantity'] += (float) $row->quantity;
        }

        return $map;
    }

    /**
     * Получить остаток по одной позиции — удобный shortcut для будущих документов.
     */
    public static function getStock(
        string $dbName,
        string $docDate,
        int    $projectId,
        int    $biId,
        ?int   $info1Id = null,
        ?int   $info2Id = null,
        ?int   $info3Id = null
    ): array {
        $result = self::calculate($dbName, $docDate, $projectId, [[
            'bi_id'      => $biId,
            'info_1_id'  => $info1Id,
            'info_2_id'  => $info2Id,
            'info_3_id'  => $info3Id,
            'quantity'   => 1, // dummy — нам нужен только stock
        ]]);

        return $result[0] ?? [
            'stock_amount'   => 0,
            'stock_quantity' => 0,
            'unit_cost'      => 0,
            'amount_cost'    => 0,
            'negative_stock' => true,
        ];
    }
}
