<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BudgetDocument;
use App\Models\Tenant\BudgetItem;
use App\Models\Tenant\BudgetOpeningBalance;
use App\Models\Tenant\BalanceItem;
use App\Services\AnalyticSlots;
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
            // Было attributes->get('user_id') — такого атрибута никто не кладёт,
            // и автор у всех бюджетов оставался пустым
            'created_by' => $this->currentUserId($request),
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
            // Разрез БДР: раздел → список видов справочника по уровням.
            // Пустой список у раздела означает «взять из слотов счёта»
            // Уровень — это вид справочника и способ показа: `tree` разворачивает
            // иерархию целиком, иначе выводится плоский список тех элементов,
            // по которым что-то есть
            'structure'                  => 'sometimes|nullable|array',
            'structure.revenue'          => 'sometimes|array|max:3',
            'structure.revenue.*.type'   => 'required|string|in:' . implode(',', AnalyticSlots::TYPES),
            'structure.revenue.*.tree'   => 'sometimes|boolean',
            'structure.cost'             => 'sometimes|array|max:3',
            'structure.cost.*.type'      => 'required|string|in:' . implode(',', AnalyticSlots::TYPES),
            'structure.cost.*.tree'      => 'sometimes|boolean',
            'structure.expenses'         => 'sometimes|array|max:3',
            'structure.expenses.*.type'  => 'required|string|in:' . implode(',', AnalyticSlots::TYPES),
            'structure.expenses.*.tree'  => 'sometimes|boolean',
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

        // Пути вида «5.12» — строка плана на статье 12 внутри отдела 5.
        // Отбираем ровно по тем уровням, что заданы: путь «5» это план на
        // самом отделе, и строки его статей сюда не попадают
        if ($request->paths) {
            $paths = array_filter(explode(',', (string) $request->paths));

            $query->where(function ($q) use ($paths) {
                foreach ($paths as $path) {
                    $ids = array_map('intval', explode('.', trim($path)));

                    $q->orWhere(function ($p) use ($ids) {
                        $p->where('article_id', $ids[0] ?? 0);
                        foreach ([2, 3] as $level) {
                            $value = $ids[$level - 1] ?? null;
                            $value ? $p->where("article_{$level}_id", $value)
                                   : $p->whereNull("article_{$level}_id");
                        }
                    });
                }
            });
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
            'article_2_id' => $item->article_2_id,
            'article_3_id' => $item->article_3_id,
            'path'         => implode('.', array_filter([$item->article_id, $item->article_2_id, $item->article_3_id])),
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
            // min:1 отсекает строку «Без статьи»: планировать по ней нечего,
            // она показывает то, что ещё предстоит разнести по статьям
            'article_id'         => 'required|integer|min:1',
            // Уровни ниже первого. Пусты — план стоит на самом отделе, а не
            // на его статье; min:1 так же отсекает строку «Без статьи»
            'article_2_id'       => 'nullable|integer|min:1',
            'article_3_id'       => 'nullable|integer|min:1',
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
            'article_id'   => 'sometimes|integer|min:1',
            'article_2_id' => 'sometimes|nullable|integer|min:1',
            'article_3_id' => 'sometimes|nullable|integer|min:1',
            'period_date'  => 'sometimes|date',
            'content'      => 'nullable|string|max:500',
            'amount'       => 'sometimes|numeric',
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
     *   - split_expenses=1 — БДР: показать расходы двумя группами, переменные и постоянные
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
        $planDetails = []; // "section:путь:cash_id:period_date" или "article_id:cash_id:period_date"
        foreach ($planRows as $row) {
            $pd  = Carbon::parse($row->period_date)->format('Y-m-d');
            $cashKey = $byCash ? ($row->cash_id ?? 0) : 0;
            $section = $row->section ?? '';
            // Строка плана может стоять на любом уровне разреза: заполнены
            // либо один id, либо два, либо три. Ключ собирается из тех, что
            // есть, — так план на отделе целиком и план на его статье лежат
            // разными строками и складываются в итоге отдела
            $path = implode('.', array_filter([$row->article_id, $row->article_2_id, $row->article_3_id]));
            $key = $section !== '' ? ($section . ':' . $path . ':' . $cashKey . ':' . $pd) : ($row->article_id . ':' . $cashKey . ':' . $pd);
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
            // Обороты без заполненной статьи получают свою строку
            $articles = $this->withUnassigned($articles, $fact);
        } else {
            // Порядок важен: разрез задаёт группировку факта, а факт решает,
            // на каких уровнях нужна строка «Без статьи»
            $bdrSections = $this->bdrSections($doc);
            $fact        = $this->getBdrFact($doc, $bdrSections, $effectiveFrom);

            // Строки строим по факту вместе с планом: на линейном уровне
            // статья без оборотов, но с планом, всё равно должна быть видна —
            // иначе введённый план негде показать и нечем поправить.
            // Объединение по ключам, значения неважны
            $articles = $this->getBdrArticles($bdrSections, $fact + $plan, (bool) $request->split_expenses);
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
            // БДР: счёт раздела и поля его уровней. Полей может быть несколько
            // — расшифровка отбирает операции по всем сразу, иначе в строке
            // «отдел → статья» показались бы все статьи отдела
            $factDrillConfig = [];
            foreach ($bdrSections as $cfg) {
                if (!$cfg['bi_id']) continue;

                $fields = array_map(fn($l) => "info_{$l['slot']}_id", $cfg['levels']);

                $factDrillConfig[$cfg['code']] = [
                    'bi_id'      => $cfg['bi_id'],
                    'info_field' => $fields[0] ?? 'info_1_id',
                    'fields'     => $fields,
                ];
            }
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
            // Разрез, с которым собран этот отчёт: настройка бюджета, уже
            // сведённая со слотами счетов. Форма настройки показывает его же
            'bdr_structure'      => isset($bdrSections)
                ? array_map(fn($c) => $this->levelsOut($c['levels']), $bdrSections)
                : null,
            // Из чего вообще можно выбрать: справочники, которые счёт раздела
            // объявил в своих слотах. Чего он не принимает, того и в разрезе
            // быть не может — группировать было бы не по чему
            'bdr_available'      => isset($bdrSections) ? $this->bdrAvailable($bdrSections) : null,
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

        // Счёт денег закрыт должностью — факта по ДДС для этого человека нет.
        // План при этом виден: он не содержит движений по счетам
        if ($this->scope->hides($a100->id)) return [];

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
            $cashKey   = $byCash ? ($row->cash_id ?? 0) : 0;
            // Статья ДДС не заполнена — сумма идёт в строку «Без статьи»
            $articleId = $row->article_id ?? self::UNASSIGNED;

            $key = $articleId . ':' . $cashKey . ':' . $row->period_date;
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
        // Счёт денег закрыт — авто-остаток не считаем: он тот же факт по
        // движениям, только накопленный
        if ($this->scope->hides($a100->id ?? null)) {
            $autoBalances[0] = 0.0;
        } elseif ($byCash) {
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

    /** Раздел БДР → счёт, с которого берётся факт */
    private const BDR_ACCOUNTS = ['revenue' => 'П587', 'cost' => 'П588', 'expenses' => 'П589'];

    /**
     * Уровни разреза каждого раздела: чем строка отчёта раскладывается вглубь.
     *
     * Настройка лежит на бюджете списком видов справочника: `["department",
     * "revenue"]` — сначала отделы, внутри статьи дохода. Номер слота в ней не
     * указывается: счёт сам объявил, что он принимает и в каком слоте, —
     * остаётся спросить. Вид, под который у счёта слота нет, из разреза
     * выпадает: группировать не по чему.
     *
     * Пустая настройка означает «как объявил счёт»: уровнями идут его слоты по
     * порядку. Так бюджеты, заведённые до появления разреза, показывают ровно
     * прежнее — у П587 и П588 это статья дохода, у П589 статья расхода.
     *
     * @return array<string, array{code: string, bi_id: ?int, levels: array}>
     */
    private function bdrSections(BudgetDocument $doc): array
    {
        $accounts = (new BalanceItem)->setConnection($this->dbName)
            ->newQuery()->whereIn('code', array_values(self::BDR_ACCOUNTS))->get()->keyBy('code');

        $structure = (array) ($doc->structure ?? []);
        $out = [];

        foreach (self::BDR_ACCOUNTS as $section => $code) {
            $account = $accounts->get($code);

            // Закрытый ролью счёт не даёт ни факта, ни разреза
            if (!$account || $this->scope->hides($account->id)) {
                $out[$section] = ['code' => $code, 'bi_id' => null, 'levels' => []];
                continue;
            }

            // Уровень записывается объектом {type, tree}. Строку тоже понимаем:
            // так настройка выглядела до появления выбора «дерево или список»
            $wanted = [];
            foreach ((array) ($structure[$section] ?? []) as $entry) {
                $type = is_array($entry) ? ($entry['type'] ?? null) : $entry;
                if (!$type) continue;

                $wanted[] = ['type' => $type, 'tree' => is_array($entry) ? (bool) ($entry['tree'] ?? true) : true];
            }

            // Без настройки — один уровень по первому слоту счёта, то есть
            // ровно прежнее поведение. Не «все слоты подряд»: у П589 второй
            // слот это контрагент, и разрез по нему никто не просил, а строки
            // плана старых бюджетов лежат одноуровневыми и уехали бы не туда
            if (!$wanted) {
                foreach (AnalyticSlots::SLOTS as $n) {
                    $types = AnalyticSlots::types($account, $n);
                    if ($types) { $wanted[] = ['type' => $types[0], 'tree' => true]; break; }
                }
            }

            $levels = [];
            $taken  = [];

            foreach ($wanted as $level) {
                foreach (AnalyticSlots::slotsFor($account, $level['type']) as $slot) {
                    if (isset($taken[$slot])) continue;

                    $taken[$slot] = true;
                    $levels[] = $level + ['slot' => $slot];
                    break;
                }
            }

            $out[$section] = [
                'code'   => $code,
                'bi_id'  => (int) $account->id,
                'levels' => array_slice($levels, 0, 3),
            ];
        }

        return $out;
    }

    /** Уровни наружу: вид справочника и способ показа, без внутреннего слота */
    private function levelsOut(array $levels): array
    {
        return array_map(fn($l) => ['type' => $l['type'], 'tree' => (bool) ($l['tree'] ?? true)], $levels);
    }

    /** Виды справочника, которые счёт раздела принимает хоть в каком слоте */
    private function bdrAvailable(array $sections): array
    {
        $accounts = (new BalanceItem)->setConnection($this->dbName)
            ->newQuery()->whereIn('code', array_values(self::BDR_ACCOUNTS))->get()->keyBy('code');

        $out = [];
        foreach ($sections as $section => $cfg) {
            $account = $accounts->get($cfg['code']);
            $out[$section] = $account ? AnalyticSlots::acceptedTypes($account) : [];
        }

        return $out;
    }

    /**
     * Факт БДР: обороты по П587/П588/П589, сгруппированные по уровням разреза.
     *
     * Ключ — `раздел:путь:0:месяц`, где путь это id по уровням через точку:
     * `5.12` — статья 12 в отделе 5. Отчёт складывает суммы по началу пути,
     * поэтому отдельные итоги по уровням считать не нужно: строка «отдел»
     * подбирает все свои статьи сама.
     *
     * Ноль вместо id — аналитика не проставлена. Такие суммы не растворяются:
     * для них в дереве появляется строка «Без статьи» на своём уровне.
     *
     * В balance_changes пассивные счета (П) хранят кредитовые обороты
     * отрицательными. Для БДР знак инвертируем: доходы вверх, расходы вниз.
     */
    private function getBdrFact(BudgetDocument $doc, array $sections, ?string $effectiveFrom = null): array
    {
        $dateFrom = Carbon::parse($effectiveFrom ?: $doc->period_from)->startOfMonth()->format('Y-m-d');
        $dateTo   = Carbon::parse($doc->period_to)->endOfMonth()->format('Y-m-d 23:59:59');

        $fact = [];

        foreach ($sections as $section => $cfg) {
            if (!$cfg['bi_id']) continue;

            $query = DB::connection($this->dbName)->table('balance_changes')
                ->where('bi_id', $cfg['bi_id'])
                ->where('date', '>=', $dateFrom)
                ->where('date', '<=', $dateTo);

            $group = [DB::raw("DATE_FORMAT(date, '%Y-%m-01')")];
            $select = [
                DB::raw("DATE_FORMAT(date, '%Y-%m-01') as period_date"),
                DB::raw('SUM(amount) as total'),
            ];

            foreach ($cfg['levels'] as $i => $level) {
                $field = "info_{$level['slot']}_id";
                $select[] = DB::raw("{$field} as l{$i}");
                $group[]  = DB::raw($field);
            }

            foreach ($query->select($select)->groupBy($group)->get() as $row) {
                $path = [];
                foreach ($cfg['levels'] as $i => $_) {
                    $path[] = (int) ($row->{"l{$i}"} ?? 0) ?: self::UNASSIGNED;
                }

                // Разреза нет вовсе — весь оборот счёта одной строкой
                $key = $section . ':' . (implode('.', $path) ?: self::UNASSIGNED) . ':0:' . $row->period_date;

                $fact[$key] = ($fact[$key] ?? 0) + (float) $row->total * -1;
            }
        }

        return $fact;
    }

    /**
     * Дерево статей БДР: revenue (доходы + себестоимость) + expenses.
     * Себестоимость использует те же статьи дохода (revenue), что и доходы,
     * т.к. на счёте П588 аналитика info_1 = revenue.
     *
     * У группы два ключа, и они разные не случайно. `group` — это раздел, по
     * нему собираются план и факт; `key` — это строка отчёта. При разделении
     * расходов обе половины остаются разделом `expenses` (счёт-то один, П589),
     * но показываются отдельными группами. Поэтому ни план, ни факт при
     * включении разделения перекладывать не нужно — меняется только вид.
     *
     * @param bool $splitExpenses разделить расходы на переменные и постоянные
     */
    private function getBdrArticles(array $sections, array $fact, bool $splitExpenses = false): array
    {
        $labels = ['revenue' => 'Доходы', 'cost' => 'Себестоимость', 'expenses' => 'Расходы'];
        $groups = [];

        foreach ($sections as $section => $cfg) {
            $tree = $this->levelTree($cfg['levels'], $section, $fact, 0, '');

            if ($section !== 'expenses' || !$splitExpenses) {
                $groups[] = ['key' => $section, 'group' => $section,
                             'label' => $labels[$section], 'items' => $tree,
                             'levels' => $this->levelsOut($cfg['levels'])];
                continue;
            }

            // Переменные и постоянные — две группы одного раздела: счёт тот же
            // П589, разрез тот же, различаются только отметкой у статьи
            foreach ([[true, 'Переменные расходы', 'expenses_var'],
                      [false, 'Постоянные расходы', 'expenses_fix']] as [$variable, $label, $key]) {
                $groups[] = ['key' => $key, 'group' => $section, 'label' => $label,
                             'items' => $this->expenseBucket($tree, $variable),
                             'levels' => $this->levelsOut($cfg['levels'])];
            }
        }

        return $groups;
    }

    /**
     * Дерево строк раздела: уровни разреза, вложенные друг в друга.
     *
     * Строку опознаёт не id справочника, а **путь** — id по уровням через
     * точку. `5` это отдел, `5.12` — статья 12 внутри отдела 5. Отчёт
     * складывает суммы по началу пути, поэтому строка отдела подбирает все
     * свои статьи сама, без отдельного счёта итогов.
     *
     * Иерархия внутри уровня (родитель-потомок в справочнике) сохраняется, и
     * следующий уровень висит под каждым узлом, а не только под листьями:
     * операция может нести и родительский отдел, и дочерний, и обе суммы
     * должны быть видны.
     *
     * Путь потомка по иерархии берёт префикс родительского узла, а не его
     * самого: в операции стоит именно дочерний элемент, и складываются они не
     * вложением, а тем, что дочерний узел лежит в поддереве родительского.
     */
    private function levelTree(array $levels, string $section, array $fact, int $depth, string $prefix): array
    {
        if (!isset($levels[$depth])) return [];

        // Линейный уровень: вместо всего справочника — только те элементы, по
        // которым в этом месте что-то есть. Сотня статей под каждым отделом
        // читается хуже, чем десяток встреченных
        $nodes = empty($levels[$depth]['tree'])
            ? $this->levelUsed($levels[$depth]['type'], $section, $fact, $prefix)
            : $this->infoTree($levels[$depth]['type']);

        $walk = function (array $items, string $parentPrefix) use (&$walk, $levels, $section, $fact, $depth) {
            $out = [];

            foreach ($items as $item) {
                $path = $parentPrefix === '' ? (string) $item['id'] : $parentPrefix . '.' . $item['id'];

                $node = $item;
                unset($node['children']);

                $node['id']      = $path;
                $node['info_id'] = $item['id'];
                $node['level']   = $depth + 1;

                $children = array_merge(
                    $walk($item['children'] ?? [], $parentPrefix),
                    $this->levelTree($levels, $section, $fact, $depth + 1, $path),
                );

                if ($children) $node['children'] = $children;

                $out[] = $node;
            }

            return $out;
        };

        $tree = $walk($nodes, $prefix);

        // «Без аналитики» на этом уровне — только если такие обороты есть.
        // Пустая строка в каждом разрезе мозолила бы глаза, а непроставленная
        // аналитика должна быть видна там, где она непроставлена
        $blank = $prefix === '' ? (string) self::UNASSIGNED : $prefix . '.' . self::UNASSIGNED;

        if ($this->factHasPath($fact, $section, $blank)) {
            $node = $this->unassignedNode();
            $node['id']       = $blank;
            $node['info_id']  = self::UNASSIGNED;
            $node['level']    = $depth + 1;
            $deeper = $this->levelTree($levels, $section, $fact, $depth + 1, $blank);
            if ($deeper) $node['children'] = $deeper;

            $tree[] = $node;
        }

        return $tree;
    }

    /**
     * Элементы уровня, которые в этом месте реально встретились, — плоско.
     *
     * Иерархию не строим и родителей не подставляем: смысл линейного уровня в
     * том, чтобы показать ровно встреченное. Порядок — как в справочнике,
     * чтобы строки не прыгали от месяца к месяцу.
     *
     * «Без статьи» сюда попадает наравне с прочими: непроставленная аналитика
     * это тоже встреченное значение, и прятать её нельзя.
     */
    private function levelUsed(string $type, string $section, array $fact, string $prefix): array
    {
        $needle = $section . ':' . ($prefix === '' ? '' : $prefix . '.');
        $seen   = [];

        foreach ($fact as $key => $value) {
            if (abs((float) $value) < 0.005) continue;
            if (!str_starts_with($key, $needle)) continue;

            $rest = substr($key, strlen($needle));
            $id   = (int) preg_split('/[.:]/', $rest)[0];

            $seen[$id] = true;
        }

        if (!$seen) return [];

        $index = $this->infoIndex($type);
        $nodes = [];

        foreach ($index as $id => $row) {
            if (isset($seen[$id])) $nodes[] = $row;
        }

        // Элемент, которого в справочнике уже нет (удалён или выключен), из
        // отчёта исчезать не должен: сумма по нему в оборотах осталась
        foreach (array_keys($seen) as $id) {
            if ($id !== self::UNASSIGNED && !isset($index[$id])) {
                $nodes[] = ['id' => $id, 'code' => null, 'name' => "#{$id}", 'parent_id' => null, 'sort_order' => PHP_INT_MAX];
            }
        }

        return $nodes;
    }

    /** Плоский справочник одного вида: id → строка, в порядке справочника */
    private function infoIndex(string $type): array
    {
        if (!isset($this->infoIndexes[$type])) {
            $out = [];
            $walk = function (array $nodes) use (&$walk, &$out) {
                foreach ($nodes as $n) {
                    $child = $n['children'] ?? [];
                    unset($n['children']);
                    $out[$n['id']] = $n;
                    $walk($child);
                }
            };
            $walk($this->infoTree($type));

            $this->infoIndexes[$type] = $out;
        }

        return $this->infoIndexes[$type];
    }

    /** @var array<string, array> */
    private array $infoIndexes = [];

    /** Есть ли в факте суммы по этому пути или под ним */
    private function factHasPath(array $fact, string $section, string $path): bool
    {
        $exact  = $section . ':' . $path . ':';
        $deeper = $section . ':' . $path . '.';

        foreach ($fact as $key => $value) {
            if (abs((float) $value) < 0.005) continue;
            if (str_starts_with($key, $exact) || str_starts_with($key, $deeper)) return true;
        }

        return false;
    }

    /** Дерево справочника одного вида. Читаем по разу: уровней бывает три */
    private function infoTree(string $type): array
    {
        if (!isset($this->infoTrees[$type])) {
            $rows = DB::connection($this->dbName)
                ->table('info')
                ->where('type', $type)
                ->whereNull('deleted_at')
                ->where('is_active', true)
                ->orderBy('sort_order')->orderBy('name')
                ->get(['id', 'parent_id', 'code', 'name', 'sort_order', 'is_variable']);

            $this->infoTrees[$type] = $this->buildTree($rows);
        }

        return $this->infoTrees[$type];
    }

    /** @var array<string, array> */
    private array $infoTrees = [];

    /**
     * Половина дерева статей — переменные или постоянные.
     *
     * Статья попадает в половину по собственной отметке, а не по родительской:
     * у «02 Цех» налоги переменные, а расходы на команду постоянные, и в
     * отчёте он стоит в обеих половинах с разными детьми. Поэтому родитель,
     * которому самому здесь не место, остаётся подпоркой ради вложенности.
     *
     * Подпорка помечается `scaffold`, и это не украшение: собственную сумму
     * такой строки приплюсовывать здесь нельзя — она принадлежит другой
     * половине и иначе сосчиталась бы дважды. Отчёт суммирует по потомкам,
     * пропуская подпорки.
     */
    private function expenseBucket(array $nodes, bool $variable): array
    {
        $out = [];

        foreach ($nodes as $node) {
            $children = $this->expenseBucket($node['children'] ?? [], $variable);
            $mine     = !empty($node['is_variable']) === $variable;

            if (!$mine && !$children) continue;

            $node['scaffold'] = !$mine;

            unset($node['children']);
            if ($children) $node['children'] = $children;

            $out[] = $node;
        }

        return $out;
    }

    // ── Утилиты ──────────────────────────────────────────────────────────────

    /**
     * Строка «Без статьи»: обороты, у которых аналитика не заполнена.
     *
     * Такие обороты есть всегда — выписку загрузили, статью проставить забыли.
     * Раньше их сумма попадала в итог месяца, но не показывалась ни в одной
     * строке: колонка не сходилась по вертикали, и найти недостающее было
     * негде. Теперь у них своя строка, из которой видно сумму, а по клику —
     * сами операции, где статью и дозаполняют.
     *
     * Ноль в качестве идентификатора безопасен: в справочниках нумерация
     * начинается с единицы, поэтому со строкой реальной статьи он не сойдётся.
     */
    private const UNASSIGNED = 0;

    /** Есть ли в факте суммы без статьи (в разделе БДР или во всём ДДС) */
    private function hasUnassigned(array $fact, ?string $section = null): bool
    {
        $prefix = ($section === null ? '' : $section . ':') . self::UNASSIGNED . ':';

        foreach ($fact as $key => $value) {
            // Копейку считаем нулём: строка ради копеечного расхождения
            // мозолила бы глаза в каждом бюджете
            if (str_starts_with((string) $key, $prefix) && abs((float) $value) >= 0.005) {
                return true;
            }
        }

        return false;
    }

    /** Узел строки «Без статьи». Всегда последний: это не статья, а остаток */
    private function unassignedNode(): array
    {
        return [
            'id'         => self::UNASSIGNED,
            'code'       => '',
            'name'       => 'Без статьи',
            'parent_id'  => null,
            'sort_order' => PHP_INT_MAX,
            'unassigned' => true,
        ];
    }

    /**
     * Добавить «Без статьи» туда, где такие суммы есть.
     *
     * Пустую строку в каждый бюджет не добавляем: у аккуратно заполненной
     * компании её быть не должно, и её отсутствие — сигнал, что всё разнесено.
     */
    private function withUnassigned(array $articles, array $fact): array
    {
        // БДР: список разделов, у каждого своё дерево
        if (isset($articles[0]['group'])) {
            // Раздел может быть показан двумя группами — расходы переменные и
            // постоянные. «Без статьи» кладём в последнюю: во-первых, иначе
            // одна сумма встала бы в обе, во-вторых, неразнесённое по смыслу
            // постоянное — переменным его никто не отмечал
            $last = [];
            foreach ($articles as $i => $group) $last[$group['group']] = $i;

            foreach ($last as $section => $i) {
                if ($this->hasUnassigned($fact, $section)) {
                    $articles[$i]['items'][] = $this->unassignedNode();
                }
            }

            return $articles;
        }

        // ДДС и ПДС: одно дерево статей
        if ($this->hasUnassigned($fact)) {
            $articles[] = $this->unassignedNode();
        }

        return $articles;
    }

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
                // Есть только у статей расходов — по ней делится БДР
                if (property_exists($item, 'is_variable')) {
                    $node['is_variable'] = (bool) $item->is_variable;
                }
                if (!empty($children)) {
                    $node['children'] = $children;
                }
                $tree[] = $node;
            }
        }
        return $tree;
    }
}
