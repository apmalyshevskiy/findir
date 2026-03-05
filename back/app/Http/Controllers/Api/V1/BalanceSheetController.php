<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BalanceItem;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class BalanceSheetController extends TenantController
{
    public function index(Request $request)
    {
        $this->initTenant($request);

        $biFilter  = $request->bi_id ? (int)$request->bi_id : null;
        $dateFrom  = $request->date_from ?? date('Y-m-01');
        $dateTo    = $request->date_to   ?? date('Y-m-t');
        $infoType  = $request->info_type; // 'partner', 'cash', 'employee' и т.д.

        // Загружаем все balance_items чтобы знать их info типы
        $balanceItems = (new BalanceItem)
            ->setConnection($this->dbName)
            ->newQuery()
            ->orderBy('code')
            ->get()
            ->keyBy('id');

        // Для каждого bi_id определяем какое поле использовать для нужного info_type
        // bi_id => 'info_1_id' | 'info_2_id' | 'info_3_id' | null
        $biInfoField = [];
        if ($infoType) {
            foreach ($balanceItems as $id => $bi) {
                if ($bi->info_1_type === $infoType) $biInfoField[$id] = 'info_1_id';
                elseif ($bi->info_2_type === $infoType) $biInfoField[$id] = 'info_2_id';
                elseif ($bi->info_3_type === $infoType) $biInfoField[$id] = 'info_3_id';
            }
        }

        // Получаем все изменения до периода (сальдо начальное)
        $openingRows = DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('date', '<', $dateFrom)
            ->when($biFilter, fn($q) => $q->where('bi_id', $biFilter))
            ->select('bi_id', 'info_1_id', 'info_2_id', 'info_3_id', DB::raw('SUM(amount) as balance'))
            ->groupBy('bi_id', 'info_1_id', 'info_2_id', 'info_3_id')
            ->get();

        // Получаем обороты за период
        $turnoversRows = DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('date', '>=', $dateFrom)
            ->when($biFilter, fn($q) => $q->where('bi_id', $biFilter))
            ->where('date', '<=', $dateTo . ' 23:59:59')
            ->select(
                'bi_id', 'info_1_id', 'info_2_id', 'info_3_id',
                DB::raw('SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as debit'),
                DB::raw('SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as credit')
            )
            ->groupBy('bi_id', 'info_1_id', 'info_2_id', 'info_3_id')
            ->get();

        // Собираем map: bi_id => info_id => {opening, debit, credit}
        $map = [];

        foreach ($openingRows as $row) {
            $biId   = $row->bi_id;
            $infoId = $this->resolveInfoId($row, $biInfoField[$biId] ?? null);
            $map[$biId][$infoId]['opening'] = ($map[$biId][$infoId]['opening'] ?? 0) + (float)$row->balance;
            $map[$biId][$infoId]['debit']   = $map[$biId][$infoId]['debit']   ?? 0;
            $map[$biId][$infoId]['credit']  = $map[$biId][$infoId]['credit']  ?? 0;
        }

        foreach ($turnoversRows as $row) {
            $biId   = $row->bi_id;
            $infoId = $this->resolveInfoId($row, $biInfoField[$biId] ?? null);
            if (!isset($map[$biId][$infoId])) {
                $map[$biId][$infoId] = ['opening' => 0, 'debit' => 0, 'credit' => 0];
            }
            $map[$biId][$infoId]['debit']  += (float)$row->debit;
            $map[$biId][$infoId]['credit'] += (float)$row->credit;
        }

        // Загружаем названия info элементов
        $allInfoIds = [];
        foreach ($map as $biId => $infoMap) {
            foreach (array_keys($infoMap) as $infoId) {
                if ($infoId > 0) $allInfoIds[] = $infoId;
            }
        }
        $infoItems = collect();
        if (!empty($allInfoIds)) {
            $infoItems = DB::connection($this->dbName)
                ->table('info')
                ->whereIn('id', array_unique($allInfoIds))
                ->get()
                ->keyBy('id');
        }

        // Строим результат
        $biIdsSorted = collect(array_keys($map))
            ->sortBy(fn($id) => $balanceItems->get($id)?->code ?? 'Z');

        $rows = [];
        foreach ($biIdsSorted as $biId) {
            $bi      = $balanceItems->get($biId);
            $details = $map[$biId];

            $totalOpening = array_sum(array_column($details, 'opening'));
            $totalDebit   = array_sum(array_column($details, 'debit'));
            $totalCredit  = array_sum(array_column($details, 'credit'));
            $totalClosing = $totalOpening + $totalDebit - $totalCredit;

            // Есть ли аналитика для этого счёта
            $hasAnalytics = $infoType && isset($biInfoField[$biId]);
            $children = [];

            if ($hasAnalytics) {
                foreach ($details as $infoId => $vals) {
                    $closing  = $vals['opening'] + $vals['debit'] - $vals['credit'];
                    $infoName = $infoId > 0
                        ? ($infoItems->get($infoId)?->name ?? "#{$infoId}")
                        : 'Без аналитики';

                    $children[] = [
                        'info_id'        => $infoId ?: null,
                        'info_name'      => $infoName,
                        'opening_debit'  => $vals['opening'] >= 0 ? $vals['opening'] : 0,
                        'opening_credit' => $vals['opening'] < 0  ? abs($vals['opening']) : 0,
                        'debit'          => $vals['debit'],
                        'credit'         => $vals['credit'],
                        'closing_debit'  => $closing >= 0 ? $closing : 0,
                        'closing_credit' => $closing < 0  ? abs($closing) : 0,
                    ];
                }
                usort($children, fn($a, $b) => strcmp($a['info_name'], $b['info_name']));
            }

            $rows[] = [
                'bi_id'          => $biId,
                'code'           => $bi?->code ?? '?',
                'name'           => $bi?->name ?? 'Неизвестный счёт',
                'has_analytics'  => $hasAnalytics,
                'opening_debit'  => $totalOpening >= 0 ? $totalOpening : 0,
                'opening_credit' => $totalOpening < 0  ? abs($totalOpening) : 0,
                'debit'          => $totalDebit,
                'credit'         => $totalCredit,
                'closing_debit'  => $totalClosing >= 0 ? $totalClosing : 0,
                'closing_credit' => $totalClosing < 0  ? abs($totalClosing) : 0,
                'children'       => $children,
            ];
        }

        return response()->json([
            'data'      => $rows,
            'date_from' => $dateFrom,
            'date_to'   => $dateTo,
        ]);
    }

    private function resolveInfoId(object $row, ?string $field): int
    {
        if (!$field) return 0;
        return (int)($row->$field ?? 0);
    }
}
