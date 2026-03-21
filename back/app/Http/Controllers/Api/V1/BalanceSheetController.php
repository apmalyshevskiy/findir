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
 *   Каждый узел: { info_id, info_type, info_name, opening_*, debit, credit, closing_*, children[] }
 */
class BalanceSheetController extends TenantController
{
    public function index(Request $request)
    {
        $this->initTenant($request);

        $biFilter         = $request->bi_id      ? (int)$request->bi_id      : null;
        $projectFilter    = $request->project_id ? (int)$request->project_id : null;
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

        // Для каждого bi_id и каждого info_type определяем поле (info_1_id / info_2_id / info_3_id)
        // biInfoFields[bi_id][info_type] = 'info_1_id' | 'info_2_id' | 'info_3_id' | null
        $biInfoFields = [];
        foreach ($balanceItems as $id => $bi) {
            foreach ($infoTypes as $infoType) {
                if ($bi->info_1_type === $infoType)      $biInfoFields[$id][$infoType] = 'info_1_id';
                elseif ($bi->info_2_type === $infoType)  $biInfoFields[$id][$infoType] = 'info_2_id';
                elseif ($bi->info_3_type === $infoType)  $biInfoFields[$id][$infoType] = 'info_3_id';
                else                                     $biInfoFields[$id][$infoType] = null;
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
            ->select(
                'bi_id', 'info_1_id', 'info_2_id', 'info_3_id',
                DB::raw('SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as debit'),
                DB::raw('SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as credit'),
                DB::raw('SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) as qty_debit'),
                DB::raw('SUM(CASE WHEN quantity < 0 THEN ABS(quantity) ELSE 0 END) as qty_credit')
            )
            ->groupBy('bi_id', 'info_1_id', 'info_2_id', 'info_3_id')
            ->get();

        // ── Собираем map: bi_id => [info_1_id, info_2_id, info_3_id] => {opening, debit, credit}
        // Ключ — строка "i1:i2:i3" для сохранения комбинаций аналитик
        $map = [];

        foreach ($openingRows as $row) {
            $biId = $row->bi_id;
            $key  = $this->makeKey($row);
            if (!isset($map[$biId][$key])) {
                $map[$biId][$key] = [
                    'opening' => 0, 'debit' => 0, 'credit' => 0,
                    'qty_opening' => 0, 'qty_debit' => 0, 'qty_credit' => 0,
                    'info_1_id' => (int)($row->info_1_id ?? 0),
                    'info_2_id' => (int)($row->info_2_id ?? 0),
                    'info_3_id' => (int)($row->info_3_id ?? 0),
                ];
            }
            $map[$biId][$key]['opening']     += (float) $row->balance;
            $map[$biId][$key]['qty_opening'] += (float) $row->qty_balance;
        }

        foreach ($turnoversRows as $row) {
            $biId = $row->bi_id;
            $key  = $this->makeKey($row);
            if (!isset($map[$biId][$key])) {
                $map[$biId][$key] = [
                    'opening' => 0, 'debit' => 0, 'credit' => 0,
                    'qty_opening' => 0, 'qty_debit' => 0, 'qty_credit' => 0,
                    'info_1_id' => (int)($row->info_1_id ?? 0),
                    'info_2_id' => (int)($row->info_2_id ?? 0),
                    'info_3_id' => (int)($row->info_3_id ?? 0),
                ];
            }
            $map[$biId][$key]['debit']      += (float) $row->debit;
            $map[$biId][$key]['credit']     += (float) $row->credit;
            $map[$biId][$key]['qty_debit']  += (float) $row->qty_debit;
            $map[$biId][$key]['qty_credit'] += (float) $row->qty_credit;
        }

        // ── Загружаем все info элементы которые встречаются ──────────────────
        $allInfoIds = [];
        foreach ($map as $biId => $keys) {
            foreach ($keys as $vals) {
                if ($vals['info_1_id'] > 0) $allInfoIds[] = $vals['info_1_id'];
                if ($vals['info_2_id'] > 0) $allInfoIds[] = $vals['info_2_id'];
                if ($vals['info_3_id'] > 0) $allInfoIds[] = $vals['info_3_id'];
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

        // Типы для которых нужна иерархия справочника
        $hierarchyTypes = [];
        if ($request->has('hierarchy_types')) {
            $hierarchyTypes = array_values(array_filter((array) $request->hierarchy_types));
        }

        // ── Загружаем полные деревья справочников для каждого типа аналитики
        // Только для типов с включённой иерархией — остальным передаём плоскую коллекцию
        $infoTree = [];
        foreach ($infoTypes as $infoType) {
            if (in_array($infoType, $hierarchyTypes)) {
                // Загружаем полное дерево с parent_id для построения иерархии
                $allOfType = DB::connection($this->dbName)
                    ->table('info')
                    ->where('type', $infoType)
                    ->where('is_active', true)
                    ->orderBy('sort_order')
                    ->orderBy('name')
                    ->get()
                    ->keyBy('id');
            } else {
                // Плоский режим — эмулируем коллекцию без parent_id (parent_id = null у всех)
                $allOfType = DB::connection($this->dbName)
                    ->table('info')
                    ->where('type', $infoType)
                    ->where('is_active', true)
                    ->orderBy('sort_order')
                    ->orderBy('name')
                    ->get()
                    ->map(fn($item) => (object) array_merge((array) $item, ['parent_id' => null]))
                    ->keyBy('id');
            }
            $infoTree[$infoType] = $allOfType;
        }

        // ── Строим результат ─────────────────────────────────────────────────
        $biIdsSorted = collect(array_keys($map))
            ->sortBy(fn($id) => $balanceItems->get($id)?->code ?? 'Z');

        $rows = [];
        foreach ($biIdsSorted as $biId) {
            $bi      = $balanceItems->get($biId);
            $details = $map[$biId];

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
                    $biInfoFields[$biId] ?? [],
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
        // Если запрошена иерархия — строим дерево по parent_id balance_items.
        // Родительские узлы суммируют все дочерние.
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
     * Для каждого уровня учитываем иерархию справочника (parent_id).
     *
     * @param array   $details     Строки balance_changes (сгруппированные)
     * @param array   $infoTypes   Порядок типов: ['product', 'department']
     * @param array   $fieldMap    info_type => 'info_1_id' | 'info_2_id' | ...
     * @param \Illuminate\Support\Collection $infoItems  Все info элементы (keyBy id)
     * @param array   $infoTree    info_type => коллекция элементов этого типа (для иерархии)
     * @param int     $level       Текущий уровень
     */
    private function buildChildren(
        array  $details,
        array  $infoTypes,
        array  $fieldMap,
        $infoItems,
        array  $infoTree,
        int    $level
    ): array {
        if ($level >= count($infoTypes)) return [];

        $currentType  = $infoTypes[$level];
        $currentField = $fieldMap[$currentType] ?? null;

        if (!$currentField) {
            return $this->buildChildren($details, $infoTypes, $fieldMap, $infoItems, $infoTree, $level + 1);
        }

        // Плоская группировка: info_id => [rows]
        $flatGrouped = [];
        foreach ($details as $vals) {
            $infoId = (int) ($vals[$currentField] ?? 0);
            $flatGrouped[$infoId][] = $vals;
        }

        // Получаем дерево элементов справочника данного типа
        $typeItems = $infoTree[$currentType] ?? collect();

        // Строим дерево с суммированием
        return $this->buildInfoHierarchy(
            $flatGrouped,
            $typeItems,
            $infoTypes,
            $fieldMap,
            $infoItems,
            $infoTree,
            $level,
            null  // начинаем с корневых узлов (parent_id = null)
        );
    }

    /**
     * Строим иерархическое дерево по одному типу аналитики.
     * parentId = null → корневые узлы; иначе дочерние.
     *
     * Для каждого узла суммируем данные всех его потомков
     * (т.е. если операция привязана к дочернему элементу,
     * она учитывается в сумме родителя).
     */
    private function buildInfoHierarchy(
        array  $flatGrouped,  // info_id => [rows]
        $typeItems,           // коллекция элементов справочника
        array  $infoTypes,
        array  $fieldMap,
        $infoItems,
        array  $infoTree,
        int    $level,
        ?int   $parentId
    ): array {
        // Выбираем только прямых детей данного родителя
        $children = $typeItems->filter(fn($item) => $item->parent_id === $parentId);

        $nodes = [];

        foreach ($children as $item) {
            // Собираем все id потомков (включая самого элемента)
            $descendantIds = $this->getAllDescendantIds($item->id, $typeItems);
            $descendantIds[] = $item->id;

            // Агрегируем строки для всех потомков
            $aggregated = [];
            foreach ($descendantIds as $dId) {
                foreach ($flatGrouped[$dId] ?? [] as $row) {
                    $aggregated[] = $row;
                }
            }

            if (empty($aggregated) && $this->buildInfoHierarchy(
                $flatGrouped, $typeItems, $infoTypes, $fieldMap, $infoItems, $infoTree, $level, $item->id
            ) === []) {
                // Нет данных ни у элемента ни у детей — пропускаем
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

            // Рекурсивно строим дочерние узлы этого уровня
            $innerChildren = $this->buildInfoHierarchy(
                $flatGrouped, $typeItems, $infoTypes, $fieldMap, $infoItems, $infoTree, $level, $item->id
            );

            // Следующий уровень аналитики (если есть)
            $nextLevelChildren = [];
            if (empty($innerChildren) && $level + 1 < count($infoTypes)) {
                $nextLevelChildren = $this->buildChildren(
                    $aggregated, $infoTypes, $fieldMap, $infoItems, $infoTree, $level + 1
                );
            }

            $subChildren = !empty($innerChildren) ? $innerChildren : $nextLevelChildren;

            $nodes[] = [
                'info_id'        => $item->id,
                'info_type'      => $infoTypes[$level],
                'info_name'      => $item->name,
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
        }

        // Добавляем "Без аналитики" если есть строки с info_id = 0
        if (isset($flatGrouped[0]) && $parentId === null) {
            $rows       = $flatGrouped[0];
            $opening    = array_sum(array_column($rows, 'opening'));
            $debit      = array_sum(array_column($rows, 'debit'));
            $credit     = array_sum(array_column($rows, 'credit'));
            $closing    = $opening + $debit - $credit;
            $qtyOpening = array_sum(array_column($rows, 'qty_opening'));
            $qtyDebit   = array_sum(array_column($rows, 'qty_debit'));
            $qtyCredit  = array_sum(array_column($rows, 'qty_credit'));
            $qtyClosing = $qtyOpening + $qtyDebit - $qtyCredit;
            $nodes[] = [
                'info_id'        => null,
                'info_type'      => $infoTypes[$level],
                'info_name'      => 'Без аналитики',
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
                'children'       => [],
            ];
        }

        // Сортируем по sort_order, затем по имени
        usort($nodes, function ($a, $b) use ($typeItems) {
            if ($a['info_id'] === null) return 1;
            if ($b['info_id'] === null) return -1;
            $itemA = $typeItems->get($a['info_id']);
            $itemB = $typeItems->get($b['info_id']);
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
     *
     * Для каждого родительского счёта суммируем данные всех дочерних рекурсивно.
     * Счета у которых нет данных и нет детей с данными — пропускаем.
     *
     * @param array  $flatRows     Плоский массив строк (уже с данными)
     * @param \Illuminate\Support\Collection $balanceItems  Все счета keyBy(id)
     * @param int|null $parentId   Текущий родитель (null = корневые)
     * @return array
     */
    private function buildAccountHierarchy(array $flatRows, $balanceItems, ?int $parentId): array
    {
        // Индексируем flatRows по bi_id для быстрого доступа
        $rowsByBiId = [];
        foreach ($flatRows as $row) {
            $rowsByBiId[$row['bi_id']] = $row;
        }

        return $this->buildAccountLevel($rowsByBiId, $balanceItems, $parentId);
    }

    private function buildAccountLevel(array $rowsByBiId, $balanceItems, ?int $parentId): array
    {
        // Находим прямых детей данного родителя
        $children = $balanceItems->filter(fn($bi) => $bi->parent_id === $parentId)
            ->sortBy('code');

        $nodes = [];

        foreach ($children as $bi) {
            // Рекурсивно строим детей
            $childNodes = $this->buildAccountLevel($rowsByBiId, $balanceItems, $bi->id);

            // Берём данные самого счёта (если есть в данных)
            $ownRow = $rowsByBiId[$bi->id] ?? null;

            // Если нет ни своих данных ни детей — пропускаем
            if (!$ownRow && empty($childNodes)) {
                continue;
            }

            // Суммируем данные — собственные + все дочерние рекурсивно
            $totals = $this->sumAccountNodes($ownRow, $childNodes);

            $nodes[] = array_merge($totals, [
                'bi_id'         => $bi->id,
                'code'          => $bi->code,
                'name'          => $bi->name,
                'has_analytics' => $ownRow['has_analytics'] ?? false,
                'has_quantity'  => $ownRow['has_quantity']  ?? (bool)($bi->has_quantity ?? false),
                'account_children' => $childNodes,  // дочерние счета
                'children'      => $ownRow['children'] ?? [],  // аналитика
            ]);
        }

        return $nodes;
    }

    /**
     * Суммируем числовые поля — собственная строка + рекурсивно все дочерние узлы.
     */
    private function sumAccountNodes(?array $ownRow, array $childNodes): array
    {
        $fields = [
            'opening_debit', 'opening_credit', 'debit', 'credit',
            'closing_debit', 'closing_credit',
            'qty_opening', 'qty_opening_neg', 'qty_debit', 'qty_credit',
            'qty_closing', 'qty_closing_neg',
        ];

        $totals = array_fill_keys($fields, 0.0);

        // Добавляем собственные данные
        if ($ownRow) {
            foreach ($fields as $f) {
                $totals[$f] += (float) ($ownRow[$f] ?? 0);
            }
        }

        // Добавляем данные всех дочерних узлов
        foreach ($childNodes as $child) {
            foreach ($fields as $f) {
                $totals[$f] += (float) ($child[$f] ?? 0);
            }
        }

        return $totals;
    }

    /** Составной ключ из трёх info полей */
    private function makeKey(object $row): string
    {
        return ($row->info_1_id ?? 0) . ':' . ($row->info_2_id ?? 0) . ':' . ($row->info_3_id ?? 0);
    }
}
