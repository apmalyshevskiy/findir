<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BalanceItem;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * ОСВ с поддержкой нескольких аналитик и произвольного порядка.
 *
 * Параметры запроса:
 *   date_from, date_to, bi_id (фильтр по счёту)
 *   info_types[] — массив типов аналитик в нужном порядке, например:
 *     ?info_types[]=product&info_types[]=department
 *     → первый уровень: Номенклатура, второй: Склад/Отдел
 *
 * Ответ children у каждого счёта:
 *   Одноуровневый если info_types=1, двухуровневый если info_types=2.
 *   Каждый узел: { info_id, info_type, info_name, turnover_only, opening_*, debit, credit, closing_*, children[] }
 *   Если turnover_only=true — opening_* и closing_* всегда 0, фронт рисует прочерк.
 */
class BalanceSheetController extends TenantController
{
    public function index(Request $request)
    {
        $this->initTenant($request);

        $biFilter          = $request->bi_id      ? (int)$request->bi_id      : null;
        $projectFilter     = $request->project_id ? (int)$request->project_id : null;
        $hierarchyAccounts = (bool) $request->hierarchy_accounts;
        $dateFrom  = $request->date_from ?? date('Y-m-01');
        $dateTo    = $request->date_to   ?? date('Y-m-t');

        // Поддерживаем и старый ?info_type=X и новый ?info_types[]=X&info_types[]=Y
        $infoTypes = [];
        if ($request->has('info_types')) {
            $infoTypes = array_values(array_filter((array) $request->info_types));
        } elseif ($request->info_type) {
            $infoTypes = [$request->info_type];
        }

        // Загружаем все balance_items
        $balanceItems = (new BalanceItem)
            ->setConnection($this->dbName)
            ->newQuery()
            ->orderBy('code')
            ->get()
            ->keyBy('id');

        // Для каждого bi_id и каждого info_type определяем:
        //   biInfoFields[bi_id][info_type]    = 'info_1_id' | 'info_2_id' | 'info_3_id' | null
        //   biTurnoverOnly[bi_id][info_type]  = true | false
        $biInfoFields  = [];
        $biTurnoverOnly = [];
        foreach ($balanceItems as $id => $bi) {
            foreach ($infoTypes as $infoType) {
                if ($bi->info_1_type === $infoType) {
                    $biInfoFields[$id][$infoType]  = 'info_1_id';
                    $biTurnoverOnly[$id][$infoType] = (bool) $bi->info_1_turnover_only;
                } elseif ($bi->info_2_type === $infoType) {
                    $biInfoFields[$id][$infoType]  = 'info_2_id';
                    $biTurnoverOnly[$id][$infoType] = (bool) $bi->info_2_turnover_only;
                } elseif ($bi->info_3_type === $infoType) {
                    $biInfoFields[$id][$infoType]  = 'info_3_id';
                    $biTurnoverOnly[$id][$infoType] = (bool) $bi->info_3_turnover_only;
                } else {
                    $biInfoFields[$id][$infoType]  = null;
                    $biTurnoverOnly[$id][$infoType] = false;
                }
            }
        }

        // ── Загружаем данные из balance_changes ──────────────────────────────

        $openingRows = DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('date', '<', $dateFrom)
            ->when($biFilter,      fn($q) => $q->where('bi_id',      $biFilter))
            ->when($projectFilter, fn($q) => $q->where('project_id', $projectFilter))
            ->select('bi_id', 'info_1_id', 'info_2_id', 'info_3_id',
                DB::raw('SUM(amount)   as balance'),
                DB::raw('SUM(quantity) as qty_balance'))
            ->groupBy('bi_id', 'info_1_id', 'info_2_id', 'info_3_id')
            ->get();

        $turnoversRows = DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('date', '>=', $dateFrom)
            ->when($biFilter,      fn($q) => $q->where('bi_id',      $biFilter))
            ->when($projectFilter, fn($q) => $q->where('project_id', $projectFilter))
            ->where('date', '<=', $dateTo . ' 23:59:59')
            ->select('bi_id', 'info_1_id', 'info_2_id', 'info_3_id',
                DB::raw('SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as debit'),
                DB::raw('SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as credit'),
                DB::raw('SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) as qty_debit'),
                DB::raw('SUM(CASE WHEN quantity < 0 THEN ABS(quantity) ELSE 0 END) as qty_credit'))
            ->groupBy('bi_id', 'info_1_id', 'info_2_id', 'info_3_id')
            ->get();

        // ── Объединяем opening + turnover в единый map ────────────────────────

        // map[bi_id][key] = { info_1_id, info_2_id, info_3_id, opening, debit, credit, qty_* }
        $map = [];

        foreach ($openingRows as $row) {
            $key = $row->info_1_id . ':' . $row->info_2_id . ':' . $row->info_3_id;
            $map[$row->bi_id][$key] = [
                'info_1_id'   => $row->info_1_id,
                'info_2_id'   => $row->info_2_id,
                'info_3_id'   => $row->info_3_id,
                'opening'     => (float) $row->balance,
                'debit'       => 0.0,
                'credit'      => 0.0,
                'qty_opening' => (float) $row->qty_balance,
                'qty_debit'   => 0.0,
                'qty_credit'  => 0.0,
            ];
        }

        foreach ($turnoversRows as $row) {
            $key = $row->info_1_id . ':' . $row->info_2_id . ':' . $row->info_3_id;
            if (isset($map[$row->bi_id][$key])) {
                $map[$row->bi_id][$key]['debit']      += (float) $row->debit;
                $map[$row->bi_id][$key]['credit']     += (float) $row->credit;
                $map[$row->bi_id][$key]['qty_debit']  += (float) $row->qty_debit;
                $map[$row->bi_id][$key]['qty_credit'] += (float) $row->qty_credit;
            } else {
                $map[$row->bi_id][$key] = [
                    'info_1_id'   => $row->info_1_id,
                    'info_2_id'   => $row->info_2_id,
                    'info_3_id'   => $row->info_3_id,
                    'opening'     => 0.0,
                    'debit'       => (float) $row->debit,
                    'credit'      => (float) $row->credit,
                    'qty_opening' => 0.0,
                    'qty_debit'   => (float) $row->qty_debit,
                    'qty_credit'  => (float) $row->qty_credit,
                ];
            }
        }

        // ── Загружаем справочники info для иерархии аналитик ─────────────────

        $infoItemsAll = DB::connection($this->dbName)
            ->table('info')
            ->whereNull('deleted_at')
            ->get(['id', 'parent_id', 'name', 'type', 'sort_order']);

        $infoItems = $infoItemsAll->keyBy('id');
        $infoTree  = [];
        foreach ($infoTypes as $type) {
            $infoTree[$type] = $infoItemsAll->where('type', $type)->values();
        }

        // ── Иерархия счетов: нужна для сортировки по коду ────────────────────

        $biIdsSorted = collect($map)->keys()
            ->sortBy(fn($id) => $balanceItems->get($id)?->code ?? 'Z')
            ->values()->all();

        $rows = [];
        foreach ($biIdsSorted as $biId) {
            $bi      = $balanceItems->get($biId);
            $details = array_values($map[$biId]);

            $totalOpening    = array_sum(array_column($details, 'opening'));
            $totalDebit      = array_sum(array_column($details, 'debit'));
            $totalCredit     = array_sum(array_column($details, 'credit'));
            $totalClosing    = $totalOpening + $totalDebit - $totalCredit;
            $qtyOpening      = array_sum(array_column($details, 'qty_opening'));
            $qtyDebit        = array_sum(array_column($details, 'qty_debit'));
            $qtyCredit       = array_sum(array_column($details, 'qty_credit'));
            $qtyClosing      = $qtyOpening + $qtyDebit - $qtyCredit;
            $hasQty          = (bool) ($bi?->has_quantity ?? false);

            // Есть ли хоть одна из запрошенных аналитик у этого счёта
            $activeInfoTypes = [];
            foreach ($infoTypes as $it) {
                if (!empty($biInfoFields[$biId][$it])) $activeInfoTypes[] = $it;
            }
            $hasAnalytics = !empty($activeInfoTypes);

            $children = [];
            if ($hasAnalytics) {
                $children = $this->buildChildren(
                    $details,
                    $infoTypes,
                    $biInfoFields[$biId]  ?? [],
                    $biTurnoverOnly[$biId] ?? [],   // ← передаём флаги turnover_only
                    $infoItems,
                    $infoTree,
                    0
                );
            }

            $rows[] = [
                'bi_id'          => $biId,
                'code'           => $bi?->code ?? '?',
                'name'           => $bi?->name ?? 'Неизвестный счёт',
                'has_analytics'  => $hasAnalytics,
                'has_quantity'   => $hasQty,
                // Строка счёта — сальдо всегда показываем
                'opening_debit'  => $totalOpening >= 0 ? $totalOpening : 0,
                'opening_credit' => $totalOpening < 0  ? abs($totalOpening) : 0,
                'debit'          => $totalDebit,
                'credit'         => $totalCredit,
                'closing_debit'  => $totalClosing >= 0 ? $totalClosing : 0,
                'closing_credit' => $totalClosing < 0  ? abs($totalClosing) : 0,
                'qty_opening'    => $qtyOpening >= 0 ? $qtyOpening : 0,
                'qty_opening_neg'=> $qtyOpening < 0  ? abs($qtyOpening) : 0,
                'qty_debit'      => $qtyDebit,
                'qty_credit'     => $qtyCredit,
                'qty_closing'    => $qtyClosing >= 0 ? $qtyClosing : 0,
                'qty_closing_neg'=> $qtyClosing < 0  ? abs($qtyClosing) : 0,
                'children'       => $children,
            ];
        }

        // ── Иерархия счетов ──────────────────────────────────────────────────
        if ($hierarchyAccounts) {
            $rows = $this->buildAccountHierarchy($rows, $balanceItems, null);
        }

        return response()->json([
            'data'              => $rows,
            'date_from'         => $dateFrom,
            'date_to'           => $dateTo,
            'info_types'        => $infoTypes,
            'hierarchy_accounts'=> $hierarchyAccounts,
        ]);
    }

    /**
     * Рекурсивно строим дерево аналитик по заданному порядку типов.
     *
     * @param array $turnoverOnlyMap  info_type => bool  (для текущего счёта)
     */
    private function buildChildren(
        array  $details,
        array  $infoTypes,
        array  $fieldMap,
        array  $turnoverOnlyMap,   // ← новый параметр
        $infoItems,
        array  $infoTree,
        int    $level
    ): array {
        if ($level >= count($infoTypes)) return [];

        $currentType  = $infoTypes[$level];
        $currentField = $fieldMap[$currentType] ?? null;

        if (!$currentField) {
            return $this->buildChildren(
                $details, $infoTypes, $fieldMap, $turnoverOnlyMap, $infoItems, $infoTree, $level + 1
            );
        }

        // Плоская группировка: info_id => [rows]
        $flatGrouped = [];
        foreach ($details as $vals) {
            $infoId = (int) ($vals[$currentField] ?? 0);
            $flatGrouped[$infoId][] = $vals;
        }

        $typeItems   = $infoTree[$currentType] ?? collect();
        $turnoverOnly = $turnoverOnlyMap[$currentType] ?? false;

        return $this->buildInfoHierarchy(
            $flatGrouped,
            $typeItems,
            $infoTypes,
            $fieldMap,
            $turnoverOnlyMap,
            $infoItems,
            $infoTree,
            $level,
            null,
            $turnoverOnly
        );
    }

    /**
     * Строим иерархическое дерево по одному типу аналитики.
     *
     * @param bool $turnoverOnly  Если true — opening/closing = 0, добавляем флаг turnover_only
     */
    private function buildInfoHierarchy(
        array  $flatGrouped,
        $typeItems,
        array  $infoTypes,
        array  $fieldMap,
        array  $turnoverOnlyMap,   // ← новый параметр
        $infoItems,
        array  $infoTree,
        int    $level,
        ?int   $parentId,
        bool   $turnoverOnly = false
    ): array {
        $children = $typeItems->filter(fn($item) => $item->parent_id === $parentId);

        $nodes = [];

        foreach ($children as $item) {
            $descendantIds   = $this->getAllDescendantIds($item->id, $typeItems);
            $descendantIds[] = $item->id;

            $aggregated = [];
            foreach ($descendantIds as $dId) {
                foreach ($flatGrouped[$dId] ?? [] as $row) {
                    $aggregated[] = $row;
                }
            }

            if (empty($aggregated) && $this->buildInfoHierarchy(
                $flatGrouped, $typeItems, $infoTypes, $fieldMap, $turnoverOnlyMap,
                $infoItems, $infoTree, $level, $item->id, $turnoverOnly
            ) === []) {
                continue;
            }

            $opening    = array_sum(array_column($aggregated, 'opening'));
            $debit      = array_sum(array_column($aggregated, 'debit'));
            $credit     = array_sum(array_column($aggregated, 'credit'));
            $closing    = $opening + $debit - $credit;
            $qtyOpening = array_sum(array_column($aggregated, 'qty_opening'));
            $qtyDebit   = array_sum(array_column($aggregated, 'qty_debit'));
            $qtyCredit  = array_sum(array_column($aggregated, 'qty_credit'));
            $qtyClosing = $qtyOpening + $qtyDebit - $qtyCredit;

            // Рекурсивно строим дочерние узлы этого уровня (иерархия справочника)
            $innerChildren = $this->buildInfoHierarchy(
                $flatGrouped, $typeItems, $infoTypes, $fieldMap, $turnoverOnlyMap,
                $infoItems, $infoTree, $level, $item->id, $turnoverOnly
            );

            // Следующий уровень аналитики (если иерархия справочника закончилась)
            $nextLevelChildren = [];
            if (empty($innerChildren) && $level + 1 < count($infoTypes)) {
                $nextLevelChildren = $this->buildChildren(
                    $aggregated, $infoTypes, $fieldMap, $turnoverOnlyMap,
                    $infoItems, $infoTree, $level + 1
                );
            }

            $subChildren = !empty($innerChildren) ? $innerChildren : $nextLevelChildren;

            // ── Применяем turnover_only ───────────────────────────────────────
            // Если флаг установлен — обнуляем сальдо (opening/closing),
            // только обороты (debit/credit) имеют смысл.
            if ($turnoverOnly) {
                $opening    = 0.0;
                $closing    = 0.0;
                $qtyOpening = 0.0;
                $qtyClosing = 0.0;
            }

            $node = [
                'info_id'        => $item->id,
                'info_type'      => $infoTypes[$level],
                'info_name'      => $item->name,
                'turnover_only'  => $turnoverOnly,   // ← фронт использует для прочерков
                'opening_debit'  => $opening >= 0 ? $opening : 0,
                'opening_credit' => $opening < 0  ? abs($opening) : 0,
                'debit'          => $debit,
                'credit'         => $credit,
                'closing_debit'  => $closing >= 0 ? $closing : 0,
                'closing_credit' => $closing < 0  ? abs($closing) : 0,
                'qty_opening'    => $qtyOpening >= 0 ? $qtyOpening : 0,
                'qty_opening_neg'=> $qtyOpening < 0  ? abs($qtyOpening) : 0,
                'qty_debit'      => $qtyDebit,
                'qty_credit'     => $qtyCredit,
                'qty_closing'    => $qtyClosing >= 0 ? $qtyClosing : 0,
                'qty_closing_neg'=> $qtyClosing < 0  ? abs($qtyClosing) : 0,
                'children'       => $subChildren,
            ];

            $nodes[] = $node;
        }

        usort($nodes, function ($a, $b) use ($infoItems) {
            $itemA = $infoItems->get($a['info_id']);
            $itemB = $infoItems->get($b['info_id']);
            $sortA = $itemA?->sort_order ?? 0;
            $sortB = $itemB?->sort_order ?? 0;
            if ($sortA !== $sortB) return $sortA - $sortB;
            return strcmp($a['info_name'], $b['info_name']);
        });

        return $nodes;
    }

    /**
     * Рекурсивно получаем все id потомков элемента.
     */
    private function getAllDescendantIds(int $parentId, $typeItems): array
    {
        $ids = [];
        $directChildren = $typeItems->filter(fn($item) => $item->parent_id === $parentId);
        foreach ($directChildren as $child) {
            $ids[] = $child->id;
            $ids   = array_merge($ids, $this->getAllDescendantIds($child->id, $typeItems));
        }
        return $ids;
    }

    /**
     * Строим иерархическое дерево счетов по parent_id из balance_items.
     */
    private function buildAccountHierarchy(array $flatRows, $balanceItems, ?int $parentId): array
    {
        $rowsByBiId = [];
        foreach ($flatRows as $row) {
            $rowsByBiId[$row['bi_id']] = $row;
        }
        return $this->buildAccountLevel($rowsByBiId, $balanceItems, $parentId);
    }

    private function buildAccountLevel(array $rowsByBiId, $balanceItems, ?int $parentId): array
    {
        $children = $balanceItems->filter(fn($bi) => $bi->parent_id === $parentId)
            ->sortBy('code');

        $nodes = [];

        foreach ($children as $bi) {
            $childNodes = $this->buildAccountLevel($rowsByBiId, $balanceItems, $bi->id);
            $ownRow     = $rowsByBiId[$bi->id] ?? null;

            if (!$ownRow && empty($childNodes)) continue;

            $totals = $this->sumAccountNodes($ownRow, $childNodes);

            $nodes[] = array_merge($totals, [
                'bi_id'            => $bi->id,
                'code'             => $bi->code,
                'name'             => $bi->name,
                'has_analytics'    => $ownRow['has_analytics'] ?? false,
                'has_quantity'     => $ownRow['has_quantity']  ?? (bool)($bi->has_quantity ?? false),
                'account_children' => $childNodes,
                'children'         => $ownRow['children'] ?? [],
            ]);
        }

        return $nodes;
    }

    private function sumAccountNodes(?array $ownRow, array $childNodes): array
    {
        $fields = [
            'opening_debit', 'opening_credit',
            'debit', 'credit',
            'closing_debit', 'closing_credit',
            'qty_opening', 'qty_opening_neg',
            'qty_debit', 'qty_credit',
            'qty_closing', 'qty_closing_neg',
        ];

        $totals = array_fill_keys($fields, 0.0);

        if ($ownRow) {
            foreach ($fields as $f) {
                $totals[$f] += (float) ($ownRow[$f] ?? 0);
            }
        }

        foreach ($childNodes as $child) {
            foreach ($fields as $f) {
                $totals[$f] += (float) ($child[$f] ?? 0);
            }
        }

        return $totals;
    }
}
