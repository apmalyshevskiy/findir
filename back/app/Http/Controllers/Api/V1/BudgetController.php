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
     * Генерирует список дат периода между двумя датами (YYYY-MM-DD).
     *
     * granularity = 'month' — первое число каждого месяца (БДР/ДДС).
     * granularity = 'day'   — каждый день диапазона (платёжный календарь).
     */
    private function periodDatesBetween(string $from, string $to, string $granularity = 'month'): array
    {
        $dates = [];
        if ($granularity === 'day') {
            $period = CarbonPeriod::create(
                Carbon::parse($from)->startOfDay(),
                '1 day',
                Carbon::parse($to)->startOfDay()
            );
        } else {
            $period = CarbonPeriod::create(
                Carbon::parse($from)->startOfMonth(),
                '1 month',
                Carbon::parse($to)->startOfMonth()
            );
        }
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
            'type'       => 'required|in:dds,bdr,pdc',
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
     *
     * Для PDC — строго день в день внутри [period_from, period_to].
     * Для БДР/ДДС — расширяем до полных месяцев (исторически план хранится 1-м числом).
     */
    private function validatePeriodDate(string $date, BudgetDocument $doc): void
    {
        $d = Carbon::parse($date);

        if ($doc->type === 'pdc') {
            $from = Carbon::parse($doc->period_from)->startOfDay();
            $to   = Carbon::parse($doc->period_to)->endOfDay();
        } else {
            $from = Carbon::parse($doc->period_from)->startOfMonth();
            $to   = Carbon::parse($doc->period_to)->endOfMonth();
        }

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
     *   - by_cash=1       — детализация по кассам (только для ДДС/PDC)
     *   - display_from    — расширение диапазона влево (показать факт до начала бюджета)
     *   - granularity     — 'day' | 'month'. По умолчанию: 'day' для PDC, 'month' для остальных.
     *
     * Возвращает:
     *   - document: шапка
     *   - period_dates: ['2026-01-01', '2026-02-01', ...] или ['2026-10-15', '2026-10-16', ...]
     *   - granularity: 'day' | 'month'
     *   - articles: дерево статей (flow или revenue+expenses)
     *   - plan: { "article_id:cash_id:period_date" => amount }
     *   - fact: { "article_id:cash_id:period_date" => amount }
     *   - opening_balances: { "cash_id" => { auto: X, manual: Y, is_manual: bool } }
     */
    public function report(Request $request, int $id)
    {
        $this->initTenant($request);

        $doc = $this->docModel()->newQuery()->findOrFail($id);
        $byCash = (bool)$request->by_cash;

        // Гранулярность периода:
        // - явно указана через ?granularity=day|month
        // - иначе: для PDC по умолчанию 'day', для остальных — 'month'
        $granularity = $request->granularity
            ?: ($doc->type === 'pdc' ? 'day' : 'month');
        if (!in_array($granularity, ['day', 'month'], true)) {
            $granularity = 'month';
        }

        // display_from — расширение диапазона влево.
        // Для подневной гранулярности оперируем днями, для месячной — началом месяца.
        if ($granularity === 'day') {
            $displayFrom = $request->display_from
                ? Carbon::parse($request->display_from)->startOfDay()->format('Y-m-d')
                : null;
            $budgetPeriodFrom = Carbon::parse($doc->period_from)->startOfDay()->format('Y-m-d');
        } else {
            $displayFrom = $request->display_from
                ? Carbon::parse($request->display_from)->startOfMonth()->format('Y-m-d')
                : null;
            $budgetPeriodFrom = Carbon::parse($doc->period_from)->startOfMonth()->format('Y-m-d');
        }

        $effectiveFrom = ($displayFrom && $displayFrom < $budgetPeriodFrom)
            ? $displayFrom
            : $budgetPeriodFrom;

        $periodDates = $this->periodDatesBetween($effectiveFrom, $doc->period_to, $granularity);

        // ── Плановые данные ──────────────────────────────────────────────
        $planRows = $this->itemModel()->newQuery()
            ->where('budget_document_id', $doc->id)
            ->orderBy('id')
            ->get();

        $plan = [];
        $planDetails = []; // "section:article_id:cash_id:period_date" или "article_id:cash_id:period_date"
        foreach ($planRows as $row) {
            $pd  = Carbon::parse($row->period_date)->format('Y-m-d');
            $cashKey = $byCash ? ($row->cash_id ?? 0) : 0;
            $section = $row->section ?? '';
            $key = $section !== '' ? ($section . ':' . $row->article_id . ':' . $cashKey . ':' . $pd) : ($row->article_id . ':' . $cashKey . ':' . $pd);
            $plan[$key] = ($plan[$key] ?? 0) + (float)$row->amount;
            $planDetails[$key][] = [
                'id'      => $row->id,
                'content' => $row->content,
                'amount'  => (float)$row->amount,
            ];
        }

        // ── Дерево статей + фактические данные ───────────────────────────
        // PDC использует те же статьи и факт-источник, что и ДДС.
        if ($doc->type === 'dds' || $doc->type === 'pdc') {
            $articles = $this->getDdsArticles();
            $fact = $this->getDdsFact($doc, $periodDates, $byCash, $effectiveFrom, $granularity);
            $openingBalances = $this->getOpeningBalances($doc, $byCash, $effectiveFrom, $granularity);
        } else {
            $articles = $this->getBdrArticles();
            $fact = $this->getBdrFact($doc, $periodDates, $effectiveFrom);
            $openingBalances = [];
        }

        // ── Справочник касс (при by_cash) ─────────────────────────────────
        $cashItems = [];
        if ($byCash && ($doc->type === 'dds' || $doc->type === 'pdc')) {
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
        if ($doc->type === 'dds' || $doc->type === 'pdc') {
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
            'document'           => $doc,
            'period_dates'       => $periodDates,
            'budget_period_from' => $budgetPeriodFrom,
            'display_from'       => $effectiveFrom,
            'granularity'        => $granularity,
            'articles'           => $articles,
            'plan'               => $plan,
            'plan_details'       => $planDetails,
            'fact'               => $fact,
            'opening_balances'   => $openingBalances,
            'cash_items'         => $cashItems,
            'fact_drill_config'  => $factDrillConfig,
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
     * Факт ДДС — обороты по А100, группировка по info_2_id (flow) и периоду.
     * При by_cash=true дополнительно по info_1_id (cash).
     *
     * granularity = 'month' — группировка по началу месяца.
     * granularity = 'day'   — группировка по конкретному дню.
     */
    private function getDdsFact(BudgetDocument $doc, array $periodDates, bool $byCash, ?string $effectiveFrom = null, string $granularity = 'month'): array
    {
        $a100 = (new BalanceItem)->setConnection($this->dbName)
            ->newQuery()
            ->where('code', 'А100')
            ->first();

        if (!$a100) return [];

        // Для подневной гранулярности диапазон дат берём день-в-день,
        // для месячной — расширяем до полных месяцев.
        if ($granularity === 'day') {
            $dateFrom = $effectiveFrom
                ? Carbon::parse($effectiveFrom)->startOfDay()->format('Y-m-d')
                : Carbon::parse($doc->period_from)->startOfDay()->format('Y-m-d');
            $dateTo   = Carbon::parse($doc->period_to)->endOfDay()->format('Y-m-d 23:59:59');
            $dateFormat = '%Y-%m-%d';
        } else {
            $dateFrom = $effectiveFrom
                ? Carbon::parse($effectiveFrom)->startOfMonth()->format('Y-m-d')
                : Carbon::parse($doc->period_from)->startOfMonth()->format('Y-m-d');
            $dateTo   = Carbon::parse($doc->period_to)->endOfMonth()->format('Y-m-d 23:59:59');
            $dateFormat = '%Y-%m-01';
        }

        $selectFields = [
            'info_2_id as article_id',
            DB::raw("DATE_FORMAT(date, '{$dateFormat}') as period_date"),
            DB::raw('SUM(amount) as total'),
        ];
        $groupBy = ['info_2_id', DB::raw("DATE_FORMAT(date, '{$dateFormat}')")];

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
     * Начальные остатки для ДДС/PDC.
     *
     * Автоматически: сумма по А100 до effectiveFrom.
     * Ручные: из budget_opening_balances если is_manual=true.
     *
     * granularity = 'day' — берём остаток на конкретную дату.
     * granularity = 'month' — округляем до начала месяца.
     */
    private function getOpeningBalances(BudgetDocument $doc, bool $byCash, ?string $effectiveFrom = null, string $granularity = 'month'): array
    {
        $a100 = (new BalanceItem)->setConnection($this->dbName)
            ->newQuery()
            ->where('code', 'А100')
            ->first();

        if ($granularity === 'day') {
            $dateFrom = $effectiveFrom
                ? Carbon::parse($effectiveFrom)->startOfDay()->format('Y-m-d')
                : Carbon::parse($doc->period_from)->startOfDay()->format('Y-m-d');
        } else {
            $dateFrom = $effectiveFrom
                ? Carbon::parse($effectiveFrom)->startOfMonth()->format('Y-m-d')
                : Carbon::parse($doc->period_from)->startOfMonth()->format('Y-m-d');
        }

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
    private function getBdrFact(BudgetDocument $doc, array $periodDates, ?string $effectiveFrom = null): array
    {
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

        $dateFrom = $effectiveFrom
            ? Carbon::parse($effectiveFrom)->startOfMonth()->format('Y-m-d')
            : Carbon::parse($doc->period_from)->startOfMonth()->format('Y-m-d');
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
