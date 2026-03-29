<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BudgetDocument;
use App\Models\Tenant\BudgetItem;
use App\Models\Tenant\BudgetOpeningBalance;
use App\Models\Tenant\BalanceItem;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Carbon\Carbon;
use Carbon\CarbonPeriod;

class BudgetController extends TenantController
{
    // ── Helpers ──────────────────────────────────────────────────────────────

    private function docModel(): BudgetDocument
    {
        return (new BudgetDocument)->setConnection($this->dbName);
    }

    private function itemModel(): BudgetItem
    {
        return (new BudgetItem)->setConnection($this->dbName);
    }

    private function openingModel(): BudgetOpeningBalance
    {
        return (new BudgetOpeningBalance)->setConnection($this->dbName);
    }

    /**
     * Генерирует список дат начала каждого месяца (YYYY-MM-DD) между двумя датами.
     */
    private function periodDatesBetween(string $from, string $to): array
    {
        $dates = [];
        $period = CarbonPeriod::create(
            Carbon::parse($from)->startOfMonth(),
            '1 month',
            Carbon::parse($to)->startOfMonth()
        );
        foreach ($period as $date) {
            $dates[] = $date->format('Y-m-d');
        }
        return $dates;
    }

    // ── CRUD: budget_documents ───────────────────────────────────────────────

    /**
     * GET /budget-documents
     */
    public function index(Request $request)
    {
        $this->initTenant($request);

        $query = $this->docModel()->newQuery()
            ->orderByDesc('created_at');

        if (!$request->show_archived) {
            $query->where('status', '!=', 'archived');
        }

        if ($request->type) {
            $query->where('type', $request->type);
        }
        if ($request->project_id) {
            $query->where('project_id', $request->project_id);
        }

        return response()->json(['data' => $query->get()]);
    }

    /**
     * POST /budget-documents
     */
    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'       => 'required|string|max:255',
            'type'       => 'required|in:dds,bdr',
            'period_from'=> 'required|date',
            'period_to'  => 'required|date|after_or_equal:period_from',
            'project_id' => 'required|integer',
        ]);

        $doc = $this->docModel()->newQuery()->create(array_merge($data, [
            'status'     => 'draft',
            'created_by' => $request->attributes->get('user_id'),
        ]));

        return response()->json(['data' => $doc], 201);
    }

    /**
     * PUT /budget-documents/{id}
     */
    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'       => 'sometimes|string|max:255',
            'period_from'=> 'sometimes|date',
            'period_to'  => 'sometimes|date',
            'status'     => 'sometimes|in:draft,approved,archived',
            'project_id' => 'sometimes|integer',
        ]);

        $doc = $this->docModel()->newQuery()->findOrFail($id);
        $doc->update($data);

        return response()->json(['data' => $doc]);
    }

    /**
     * DELETE /budget-documents/{id}
     */
    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->docModel()->newQuery()->findOrFail($id)->delete();

        return response()->json(['message' => 'Удалено']);
    }

    // ── CRUD: budget_items ──────────────────────────────────────────────────

    /**
     * GET /budget-items?budget_document_id=X&article_ids=1,2,3&period_date=2026-03-01
     *
     * Список строк плана с фильтрами. article_ids — через запятую.
     * Подгружает название статьи.
     */
    public function indexItems(Request $request)
    {
        $this->initTenant($request);

        $request->validate([
            'budget_document_id' => 'required|integer',
        ]);

        $query = $this->itemModel()->newQuery()
            ->where('budget_document_id', $request->budget_document_id)
            ->orderBy('period_date')
            ->orderBy('article_id')
            ->orderBy('id');

        if ($request->article_ids) {
            $ids = array_map('intval', explode(',', $request->article_ids));
            $query->whereIn('article_id', $ids);
        }

        if ($request->section) {
            $query->where('section', $request->section);
        }

        if ($request->period_date) {
            $query->whereDate('period_date', $request->period_date);
        }

        $items = $query->get();

        // Подгрузим названия статей
        $articleIds = $items->pluck('article_id')->unique()->values();
        $articles = collect();
        if ($articleIds->isNotEmpty()) {
            $articles = DB::connection($this->dbName)
                ->table('info')
                ->whereIn('id', $articleIds)
                ->get(['id', 'name', 'code'])
                ->keyBy('id');
        }

        $data = $items->map(fn($item) => [
            'id'           => $item->id,
            'article_id'   => $item->article_id,
            'article_name' => $articles->get($item->article_id)?->name ?? "#{$item->article_id}",
            'section'      => $item->section,
            'cash_id'      => $item->cash_id,
            'period_date'  => $item->period_date?->format('Y-m-d'),
            'content'      => $item->content,
            'amount'       => (float)$item->amount,
        ]);

        return response()->json(['data' => $data]);
    }

    /**
     * POST /budget-items
     */
    public function storeItem(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'budget_document_id' => 'required|integer',
            'article_id'         => 'required|integer',
            'section'            => 'nullable|string|in:revenue,cost,expenses',
            'cash_id'            => 'nullable|integer',
            'period_date'        => 'required|date',
            'content'            => 'nullable|string|max:500',
            'amount'             => 'required|numeric',
        ]);

        $doc = $this->docModel()->newQuery()->findOrFail($data['budget_document_id']);
        $this->validatePeriodDate($data['period_date'], $doc);

        $item = $this->itemModel()->newQuery()->create($data);

        // Подгрузить название статьи
        $articleName = DB::connection($this->dbName)
            ->table('info')->where('id', $item->article_id)->value('name') ?? '';

        return response()->json(['data' => array_merge($item->toArray(), [
            'article_name' => $articleName,
            'section'      => $item->section,
            'period_date'  => $item->period_date?->format('Y-m-d'),
        ])], 201);
    }

    /**
     * PUT /budget-items/{id}
     *
     * Можно менять: article_id, period_date, content, amount
     */
    public function updateItem(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'article_id'  => 'sometimes|integer',
            'period_date' => 'sometimes|date',
            'content'     => 'nullable|string|max:500',
            'amount'      => 'sometimes|numeric',
        ]);

        $item = $this->itemModel()->newQuery()->findOrFail($id);

        // Валидация period_date если меняется
        if (isset($data['period_date'])) {
            $doc = $this->docModel()->newQuery()->findOrFail($item->budget_document_id);
            $this->validatePeriodDate($data['period_date'], $doc);
        }

        $item->update($data);

        $articleName = DB::connection($this->dbName)
            ->table('info')->where('id', $item->article_id)->value('name') ?? '';

        return response()->json(['data' => array_merge($item->toArray(), [
            'article_name' => $articleName,
            'period_date'  => $item->period_date?->format('Y-m-d'),
        ])]);
    }

    /**
     * DELETE /budget-items/{id}
     */
    public function destroyItem(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->itemModel()->newQuery()->findOrFail($id)->delete();

        return response()->json(['message' => 'Удалено']);
    }

    /**
     * Проверяет что period_date попадает в рамки документа.
     */
    private function validatePeriodDate(string $date, BudgetDocument $doc): void
    {
        $d = Carbon::parse($date);
        $from = Carbon::parse($doc->period_from)->startOfMonth();
        $to   = Carbon::parse($doc->period_to)->endOfMonth();

        if ($d->lt($from) || $d->gt($to)) {
            abort(422, "period_date {$date} выходит за рамки бюджета ({$doc->period_from} — {$doc->period_to})");
        }
    }

    // ── UPSERT: budget_opening_balances ──────────────────────────────────────

    /**
     * PUT /budget-opening-balances/upsert
     *
     * Тело: { budget_document_id, cash_id?, amount, is_manual? }
     */
    public function upsertOpeningBalance(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'budget_document_id' => 'required|integer',
            'cash_id'            => 'nullable|integer',
            'amount'             => 'required|numeric',
            'is_manual'          => 'sometimes|boolean',
        ]);

        $balance = $this->openingModel()->newQuery()->updateOrCreate(
            [
                'budget_document_id' => $data['budget_document_id'],
                'cash_id'            => $data['cash_id'] ?? null,
            ],
            [
                'amount'    => $data['amount'],
                'is_manual' => $data['is_manual'] ?? true,
            ]
        );

        return response()->json(['data' => $balance]);
    }

    // ── ОТЧЁТ: plan-fact ─────────────────────────────────────────────────────

    /**
     * GET /budget-report/{id}
     *
     * Параметры:
     *   - by_cash=1  — детализация по кассам (только для ДДС)
     *
     * Возвращает:
     *   - document: шапка
     *   - period_dates: ['2026-01-01', '2026-02-01', ...]
     *   - articles: дерево статей (flow или revenue+expenses)
     *   - plan: { "article_id:cash_id:2026-01-01" => amount }
     *   - fact: { "article_id:cash_id:2026-01-01" => amount }
     *   - opening_balances: { "cash_id" => { auto: X, manual: Y, is_manual: bool } }
     */
    public function report(Request $request, int $id)
    {
        $this->initTenant($request);

        $doc = $this->docModel()->newQuery()->findOrFail($id);
        $periodDates = $this->periodDatesBetween($doc->period_from, $doc->period_to);
        $byCash = (bool)$request->by_cash;

        // ── Плановые данные ──────────────────────────────────────────────
        $planRows = $this->itemModel()->newQuery()
            ->where('budget_document_id', $doc->id)
            ->orderBy('id')
            ->get();

        $plan = [];
        $planDetails = []; // "section:article_id:cash_id:period_date" => [ {id, content, amount}, ... ]
        foreach ($planRows as $row) {
            $pd  = Carbon::parse($row->period_date)->format('Y-m-d');
            $cashKey = $byCash ? ($row->cash_id ?? 0) : 0;
            $section = $row->section ?? '';
            $key = $section . ':' . $row->article_id . ':' . $cashKey . ':' . $pd;
            $plan[$key] = ($plan[$key] ?? 0) + (float)$row->amount;
            $planDetails[$key][] = [
                'id'      => $row->id,
                'content' => $row->content,
                'amount'  => (float)$row->amount,
            ];
        }

        // ── Дерево статей + фактические данные ───────────────────────────
        if ($doc->type === 'dds') {
            $articles = $this->getDdsArticles();
            $fact = $this->getDdsFact($doc, $periodDates, $byCash);
            $openingBalances = $this->getOpeningBalances($doc, $byCash);
        } else {
            $articles = $this->getBdrArticles();
            $fact = $this->getBdrFact($doc, $periodDates);
            $openingBalances = [];
        }

        // ── Справочник касс (при by_cash) ─────────────────────────────────
        $cashItems = [];
        if ($byCash && $doc->type === 'dds') {
            $cashItems = DB::connection($this->dbName)
                ->table('info')
                ->where('type', 'cash')
                ->whereNull('deleted_at')
                ->where('is_active', true)
                ->orderBy('sort_order')
                ->get(['id', 'code', 'name'])
                ->toArray();
        }

        // ── Конфиг для drill-down факта ──────────────────────────────────
        $factDrillConfig = [];
        if ($doc->type === 'dds') {
            $a100 = (new BalanceItem)->setConnection($this->dbName)->newQuery()->where('code', 'А100')->first();
            if ($a100) {
                $factDrillConfig = ['bi_id' => $a100->id, 'info_field' => 'info_2_id'];
            }
        } else {
            // БДР: три счёта, каждый со своей аналитикой
            $biMap = [];
            $drillFields = ['П587' => 'info_1_id', 'П588' => 'info_1_id', 'П589' => 'info_1_id'];
            foreach ($drillFields as $code => $field) {
                $bi = (new BalanceItem)->setConnection($this->dbName)->newQuery()->where('code', $code)->first();
                if ($bi) $biMap[$code] = ['bi_id' => $bi->id, 'info_field' => $field];
            }
            $factDrillConfig = $biMap;
        }

        return response()->json([
            'document'          => $doc,
            'period_dates'      => $periodDates,
            'articles'          => $articles,
            'plan'              => $plan,
            'plan_details'      => $planDetails,
            'fact'              => $fact,
            'opening_balances'  => $openingBalances,
            'cash_items'        => $cashItems,
            'fact_drill_config' => $factDrillConfig,
        ]);
    }

    // ── Приватные: ДДС ───────────────────────────────────────────────────────

    /**
     * Дерево статей ДДС (info type=flow).
     */
    private function getDdsArticles(): array
    {
        $items = DB::connection($this->dbName)
            ->table('info')
            ->where('type', 'flow')
            ->whereNull('deleted_at')
            ->where('is_active', true)
            ->orderBy('sort_order')
            ->orderBy('name')
            ->get(['id', 'parent_id', 'code', 'name', 'sort_order']);

        return $this->buildTree($items);
    }

    /**
     * Факт ДДС — обороты по А100, группировка по info_2_id (flow) и началу месяца.
     * При by_cash=true дополнительно по info_1_id (cash).
     */
    private function getDdsFact(BudgetDocument $doc, array $periodDates, bool $byCash): array
    {
        // Найти id счёта А100
        $a100 = (new BalanceItem)->setConnection($this->dbName)
            ->newQuery()
            ->where('code', 'А100')
            ->first();

        if (!$a100) return [];

        $dateFrom = Carbon::parse($doc->period_from)->startOfMonth()->format('Y-m-d');
        $dateTo   = Carbon::parse($doc->period_to)->endOfMonth()->format('Y-m-d 23:59:59');

        $selectFields = [
            'info_2_id as article_id',
            DB::raw("DATE_FORMAT(date, '%Y-%m-01') as period_date"),
            DB::raw('SUM(amount) as total'),
        ];
        $groupBy = ['info_2_id', DB::raw("DATE_FORMAT(date, '%Y-%m-01')")];

        if ($byCash) {
            array_unshift($selectFields, 'info_1_id as cash_id');
            array_unshift($groupBy, 'info_1_id');
        }

        $rows = DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('bi_id', $a100->id)
            ->where('date', '>=', $dateFrom)
            ->where('date', '<=', $dateTo)
            ->select($selectFields)
            ->groupBy($groupBy)
            ->get();

        $fact = [];
        foreach ($rows as $row) {
            $cashKey = $byCash ? ($row->cash_id ?? 0) : 0;
            $key = $row->article_id . ':' . $cashKey . ':' . $row->period_date;
            $fact[$key] = (float)$row->total;
        }

        return $fact;
    }

    /**
     * Начальные остатки для ДДС.
     *
     * Автоматически: сумма по А100 до period_from.
     * Ручные: из budget_opening_balances если is_manual=true.
     */
    private function getOpeningBalances(BudgetDocument $doc, bool $byCash): array
    {
        $a100 = (new BalanceItem)->setConnection($this->dbName)
            ->newQuery()
            ->where('code', 'А100')
            ->first();

        $dateFrom = Carbon::parse($doc->period_from)->startOfMonth()->format('Y-m-d');

        // Авто-остаток из balance_changes
        $autoQuery = DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('bi_id', $a100->id)
            ->where('date', '<', $dateFrom);

        $autoBalances = [];
        if ($byCash) {
            $rows = $autoQuery
                ->select('info_1_id as cash_id', DB::raw('SUM(amount) as balance'))
                ->groupBy('info_1_id')
                ->get();
            foreach ($rows as $row) {
                $autoBalances[$row->cash_id ?? 0] = (float)$row->balance;
            }
        } else {
            $total = $autoQuery->sum('amount');
            $autoBalances[0] = (float)$total;
        }

        // Ручные переопределения
        $manualRows = $this->openingModel()->newQuery()
            ->where('budget_document_id', $doc->id)
            ->get();

        $result = [];
        foreach ($autoBalances as $cashId => $autoAmount) {
            $result[$cashId] = [
                'auto'      => $autoAmount,
                'manual'    => null,
                'is_manual' => false,
            ];
        }

        foreach ($manualRows as $row) {
            $cashId = $byCash ? ($row->cash_id ?? 0) : 0;
            if (!isset($result[$cashId])) {
                $result[$cashId] = ['auto' => 0, 'manual' => null, 'is_manual' => false];
            }
            if ($row->is_manual) {
                $result[$cashId]['manual']    = (float)$row->amount;
                $result[$cashId]['is_manual'] = true;
            }
        }

        return $result;
    }

    // ── Приватные: БДР ───────────────────────────────────────────────────────

    /**
     * Дерево статей БДР: revenue (доходы + себестоимость) + expenses.
     * Себестоимость использует те же статьи дохода (revenue), что и доходы,
     * т.к. на счёте П588 аналитика info_1 = revenue.
     */
    private function getBdrArticles(): array
    {
        $revenues = DB::connection($this->dbName)
            ->table('info')
            ->where('type', 'revenue')
            ->whereNull('deleted_at')
            ->where('is_active', true)
            ->orderBy('sort_order')->orderBy('name')
            ->get(['id', 'parent_id', 'code', 'name', 'sort_order']);

        $expenses = DB::connection($this->dbName)
            ->table('info')
            ->where('type', 'expenses')
            ->whereNull('deleted_at')
            ->where('is_active', true)
            ->orderBy('sort_order')->orderBy('name')
            ->get(['id', 'parent_id', 'code', 'name', 'sort_order']);

        return [
            ['group' => 'revenue',    'label' => 'Доходы',        'items' => $this->buildTree($revenues)],
            ['group' => 'cost',       'label' => 'Себестоимость', 'items' => $this->buildTree($revenues)],
            ['group' => 'expenses',   'label' => 'Расходы',       'items' => $this->buildTree($expenses)],
        ];
    }

    /**
     * Факт БДР — обороты по П587 (доходы), П588 (себестоимость), П589 (расходы).
     *
     * В balance_changes пассивные счета (П) хранят кредитовые обороты как отрицательные.
     * Для БДР инвертируем знак: доходы → положительные, расходы → отрицательные.
     */
    private function getBdrFact(BudgetDocument $doc, array $periodDates): array
    {
        // code => [info_field, sign_multiplier]
        // В balance_changes: Дт = +, Кт = -
        // П587 доходы:       Кт (credit) → balance_changes = -114000 → *(-1) = +114000
        // П588 себестоимость: Дт (debit)  → balance_changes = +76560  → *(-1) = -76560
        // П589 расходы:      Дт (debit)  → balance_changes = +10423  → *(-1) = -10423
        // Итого: доходы положительные, себестоимость и расходы — отрицательные (вычитаются)
        $biConfig = [
            'П587' => ['field' => 'info_1_id', 'sign' => -1, 'section' => 'revenue'],
            'П588' => ['field' => 'info_1_id', 'sign' => -1, 'section' => 'cost'],
            'П589' => ['field' => 'info_1_id', 'sign' => -1, 'section' => 'expenses'],
        ];

        $balanceItems = (new BalanceItem)->setConnection($this->dbName)
            ->newQuery()
            ->whereIn('code', array_keys($biConfig))
            ->get()
            ->keyBy('code');

        $dateFrom = Carbon::parse($doc->period_from)->startOfMonth()->format('Y-m-d');
        $dateTo   = Carbon::parse($doc->period_to)->endOfMonth()->format('Y-m-d 23:59:59');

        $fact = [];

        foreach ($biConfig as $code => $cfg) {
            $bi = $balanceItems->get($code);
            if (!$bi) continue;

            $infoField = $cfg['field'];
            $sign = $cfg['sign'];
            $section = $cfg['section'];

            $rows = DB::connection($this->dbName)
                ->table('balance_changes')
                ->where('bi_id', $bi->id)
                ->where('date', '>=', $dateFrom)
                ->where('date', '<=', $dateTo)
                ->select(
                    "{$infoField} as article_id",
                    DB::raw("DATE_FORMAT(date, '%Y-%m-01') as period_date"),
                    DB::raw('SUM(amount) as total')
                )
                ->groupBy($infoField, DB::raw("DATE_FORMAT(date, '%Y-%m-01')"))
                ->get();

            foreach ($rows as $row) {
                $key = $section . ':' . $row->article_id . ':0:' . $row->period_date;
                $fact[$key] = (float)$row->total * $sign;
            }
        }

        return $fact;
    }

    // ── Утилиты ──────────────────────────────────────────────────────────────

    /**
     * Строит дерево из плоского списка с parent_id.
     */
    private function buildTree($items, $parentId = null): array
    {
        $tree = [];
        foreach ($items as $item) {
            if ($item->parent_id == $parentId) {
                $children = $this->buildTree($items, $item->id);
                $node = [
                    'id'         => $item->id,
                    'code'       => $item->code,
                    'name'       => $item->name,
                    'parent_id'  => $item->parent_id,
                    'sort_order' => $item->sort_order ?? 0,
                ];
                if (!empty($children)) {
                    $node['children'] = $children;
                }
                $tree[] = $node;
            }
        }
        return $tree;
    }
}
