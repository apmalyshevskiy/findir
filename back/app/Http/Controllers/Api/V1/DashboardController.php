<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use App\Services\Access;

/**
 * Сводный дашборд с ключевыми показателями по периодам.
 *
 * GET /dashboard/summary
 *   date        — опорная дата (конец всех окон). По умолчанию — вчера.
 *   project_id  — фильтр по проекту (необязательно).
 *
 * Периоды (все заканчиваются опорной датой):
 *   day   — сама опорная дата
 *   week  — опорная дата и 6 предыдущих дней (7 дней)
 *   month — месяц до опорной даты
 *   year  — год до опорной даты
 *
 * По каждому периоду отдаём разбивку показателей по проектам (by_project)
 * и итог (total). Показатель (пока один): Выручка = нетто-оборот по кредиту
 * счёта доходов (П587). В balance_changes кредит записывается отрицательной
 * суммой, поэтому выручка = -SUM(amount).
 */
class DashboardController extends TenantController
{
    private const REVENUE_CODE = 'П587';
    private const COGS_CODE    = 'П588';
    private const EXPENSES_CODE = 'П589';
    private const CASH_CODE    = 'А100';

    public function summary(Request $request)
    {
        $this->initTenant($request);

        $projectFilter = $request->project_id ? (int) $request->project_id : null;

        // Опорная дата: выбранная или вчера.
        $anchor = $request->date
            ? Carbon::parse($request->date)->startOfDay()
            : Carbon::yesterday();

        $acc = $this->metricAccounts();

        $projectNames = DB::connection($this->dbName)
            ->table('projects')
            ->whereNull('deleted_at')
            ->pluck('name', 'id');

        $windows = [
            'day'   => ['label' => 'За день',   'from' => $anchor->copy()],
            'week'  => ['label' => 'За 7 дней', 'from' => $anchor->copy()->subDays(6)],
            'month' => ['label' => 'За месяц',  'from' => $anchor->copy()->subMonth()->addDay()],
            'year'  => ['label' => 'За год',    'from' => $anchor->copy()->subYear()->addDay()],
        ];

        $periods = [];
        foreach ($windows as $key => $w) {
            $periods[$key] = array_merge(
                ['label' => $w['label'], 'date_from' => $w['from']->toDateString(), 'date_to' => $anchor->toDateString()],
                $this->buildMetrics($acc, $w['from'], $anchor, $projectFilter, $projectNames)
            );
        }

        return response()->json([
            'reference_date' => $anchor->toDateString(),
            'multi_project'  => $projectNames->count() > 1,
            'periods'        => $periods,
        ]);
    }

    /**
     * GET /dashboard/metrics
     *   date_from, date_to (обязательны), project_id — показатели за произвольный период.
     */
    public function metrics(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'date_from' => 'required|date',
            'date_to'   => 'required|date',
        ]);
        $projectFilter = $request->project_id ? (int) $request->project_id : null;

        $from = Carbon::parse($data['date_from'])->startOfDay();
        $to   = Carbon::parse($data['date_to'])->startOfDay();
        if ($to->lt($from)) { [$from, $to] = [$to, $from]; }  // перепутаны местами — меняем

        $projectNames = DB::connection($this->dbName)
            ->table('projects')->whereNull('deleted_at')->pluck('name', 'id');

        $acc = $this->metricAccounts();

        // Прошлый период — чтобы цифра на плитке читалась не сама по себе, а
        // рядом с «было»: «28 млн» ничего не говорит, пока неизвестно, много
        // это или мало. Разбивка по проектам для него не нужна — только итог
        [$prevFrom, $prevTo] = $this->previousRange($from, $to);
        $previous = $this->buildMetrics($acc, $prevFrom, $prevTo, $projectFilter, $projectNames);

        return response()->json(array_merge(
            ['date_from' => $from->toDateString(), 'date_to' => $to->toDateString()],
            $this->buildMetrics($acc, $from, $to, $projectFilter, $projectNames),
            ['previous' => [
                'date_from' => $prevFrom->toDateString(),
                'date_to'   => $prevTo->toDateString(),
                'total'     => $previous['total'],
            ]],
        ));
    }

    /**
     * Период, с которым сравнивать.
     *
     * Календарный месяц сравниваем с прошлым календарным месяцем, год — с
     * прошлым годом: «ноябрь против октября» понятнее, чем «30 дней против
     * предыдущих 30», и не съезжает из-за разной длины месяцев. Произвольный
     * отрезок сравнивается с таким же по длине, стоящим вплотную перед ним.
     *
     * @return array{0: Carbon, 1: Carbon}
     */
    private function previousRange(Carbon $from, Carbon $to): array
    {
        $wholeMonth = $from->day === 1 && $to->isSameDay($from->copy()->endOfMonth());
        $wholeYear  = $from->isSameDay($from->copy()->startOfYear()) && $to->isSameDay($from->copy()->endOfYear());

        if ($wholeYear) {
            return [$from->copy()->subYear()->startOfYear()->startOfDay(), $from->copy()->subYear()->endOfYear()->startOfDay()];
        }
        if ($wholeMonth) {
            $prev = $from->copy()->subMonthNoOverflow();
            return [$prev->copy()->startOfMonth()->startOfDay(), $prev->copy()->endOfMonth()->startOfDay()];
        }

        $days = $from->diffInDays($to) + 1;
        $prevTo = $from->copy()->subDay();

        return [$prevTo->copy()->subDays((int) $days - 1), $prevTo];
    }

    /**
     * GET /dashboard/cash
     *   date — на какую дату остаток (по умолчанию сегодня), project_id.
     *
     * Деньги по кассам и счетам: остаток на дату и то, как он изменился с
     * начала месяца. Первый вопрос, с которым открывают программу, — «сколько
     * у нас денег», и до сих пор ответ на него был только в оборотке.
     */
    public function cash(Request $request)
    {
        $this->initTenant($request);

        $date = $request->date ? Carbon::parse($request->date)->startOfDay() : Carbon::today();
        $projectFilter = $request->project_id ? (int) $request->project_id : null;

        $biId = DB::connection($this->dbName)->table('balance_items')->where('code', self::CASH_CODE)->value('id');

        // Счёт денег закрыт должностью — не ноль, а «не показываем»
        if ($biId && $this->scope->hides((int) $biId)) {
            return response()->json(['date' => $date->toDateString(), 'hidden' => true, 'total' => null, 'items' => []]);
        }
        if (!$biId) {
            return response()->json(['date' => $date->toDateString(), 'hidden' => false, 'total' => 0, 'month_change' => 0, 'items' => []]);
        }

        $until      = $date->toDateString() . ' 23:59:59';
        $monthStart = $date->copy()->startOfMonth()->toDateString() . ' 00:00:00';

        $rows = DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('bi_id', $biId)
            ->where('date', '<=', $until)
            ->when($projectFilter, fn($q) => $q->where('project_id', $projectFilter))
            ->groupBy('info_1_id')
            ->select(
                'info_1_id',
                DB::raw('SUM(amount) as balance'),
                DB::raw("SUM(CASE WHEN `date` >= '{$monthStart}' THEN amount ELSE 0 END) as month_change"),
            )
            ->get();

        $names = DB::connection($this->dbName)->table('info')
            ->whereIn('id', $rows->pluck('info_1_id')->filter()->all())
            ->pluck('name', 'id');

        $items = [];
        $total = 0.0;
        $monthChange = 0.0;

        foreach ($rows as $r) {
            $balance = round((float) $r->balance, 2);
            $total       += $balance;
            $monthChange += (float) $r->month_change;

            // Кассу с нулевым остатком не показываем: закрытый счёт в банке
            // остаётся в справочнике годами и только удлиняет список
            if (abs($balance) < 0.005) continue;

            $items[] = [
                'id'      => $r->info_1_id ? (int) $r->info_1_id : null,
                'name'    => $r->info_1_id ? ($names[$r->info_1_id] ?? ('#' . $r->info_1_id)) : 'Без кассы',
                'balance' => $balance,
                'month_change' => round((float) $r->month_change, 2),
            ];
        }

        usort($items, fn($a, $b) => $b['balance'] <=> $a['balance']);

        return response()->json([
            'date'         => $date->toDateString(),
            'hidden'       => false,
            'total'        => round($total, 2),
            'month_change' => round($monthChange, 2),
            'items'        => $items,
        ]);
    }

    /** Виден ли человеку раздел бюджета: плитки с планом лежат на дашборде, а права у них — бюджетные */
    private function budgetVisible(Request $request): bool
    {
        $userId = $this->currentUserId($request);
        if (!$userId) return false;

        $permissions = Access::permissionsFor($this->dbName, $userId);

        return Access::allows($permissions['budget'] ?? Access::NONE, Access::VIEW);
    }

    /**
     * GET /dashboard/budget-progress
     *   date — месяц, за который смотреть (по умолчанию текущий).
     *
     * План и факт месяца по бюджету доходов и расходов: выручка,
     * себестоимость, расходы и прибыль. Берётся утверждённый бюджет, в период
     * которого попадает месяц; нет утверждённого — черновик.
     */
    public function budgetProgress(Request $request)
    {
        $this->initTenant($request);

        $month = ($request->date ? Carbon::parse($request->date) : Carbon::today())->startOfMonth();

        if (!$this->budgetVisible($request)) {
            return response()->json(['available' => false, 'reason' => 'forbidden']);
        }

        $doc = DB::connection($this->dbName)->table('budget_documents')
            ->whereNull('deleted_at')
            ->where('type', 'bdr')
            ->where('status', '!=', 'archived')
            ->where('period_from', '<=', $month->copy()->endOfMonth()->toDateString())
            ->where('period_to', '>=', $month->toDateString())
            ->orderByRaw("status = 'approved' DESC")
            ->orderByDesc('id')
            ->first(['id', 'name', 'status']);

        if (!$doc) {
            return response()->json(['available' => false, 'reason' => 'no_budget', 'month' => $month->toDateString()]);
        }

        // План хранится положительными величинами по разделам
        $plan = DB::connection($this->dbName)->table('budget_items')
            ->where('budget_document_id', $doc->id)
            ->where('period_date', $month->toDateString())
            ->groupBy('section')
            ->selectRaw('section, SUM(amount) as total')
            ->pluck('total', 'section');

        $codes = ['revenue' => self::REVENUE_CODE, 'cost' => self::COGS_CODE, 'expenses' => self::EXPENSES_CODE];
        $biIds = DB::connection($this->dbName)->table('balance_items')
            ->whereIn('code', array_values($codes))->pluck('id', 'code');

        $from = $month->toDateString() . ' 00:00:00';
        $to   = $month->copy()->endOfMonth()->toDateString() . ' 23:59:59';

        $turn = DB::connection($this->dbName)->table('balance_changes')
            ->whereIn('bi_id', $biIds->values()->all())
            ->where('date', '>=', $from)->where('date', '<=', $to)
            ->groupBy('bi_id')
            ->selectRaw('bi_id, SUM(amount) as total')
            ->pluck('total', 'bi_id');

        $labels = ['revenue' => 'Выручка', 'cost' => 'Себестоимость', 'expenses' => 'Расходы'];
        $sections = [];
        $hiddenAny = false;

        foreach ($codes as $section => $code) {
            $biId   = isset($biIds[$code]) ? (int) $biIds[$code] : null;
            $hidden = $this->scope->hides($biId);
            $hiddenAny = $hiddenAny || $hidden;

            // Доходы лежат по кредиту — отрицательными; расходы по дебету —
            // положительными. Наружу отдаём величины, а не знаки проводок
            $raw  = (float) ($turn[$biId] ?? 0);
            $fact = $section === 'revenue' ? -$raw : $raw;

            $sections[] = [
                'key'   => $section,
                'label' => $labels[$section],
                'plan'  => round(abs((float) ($plan[$section] ?? 0)), 2),
                'fact'  => $hidden ? null : round($fact, 2),
            ];
        }

        $by = array_column($sections, null, 'key');

        return response()->json([
            'available' => true,
            'month'     => $month->toDateString(),
            'document'  => ['id' => (int) $doc->id, 'name' => $doc->name, 'status' => $doc->status],
            'sections'  => $sections,
            'profit'    => [
                'plan' => round($by['revenue']['plan'] - $by['cost']['plan'] - $by['expenses']['plan'], 2),
                'fact' => $hiddenAny ? null : round($by['revenue']['fact'] - $by['cost']['fact'] - $by['expenses']['fact'], 2),
            ],
        ]);
    }

    /**
     * GET /dashboard/upcoming-payments
     *   date — от какого дня (по умолчанию сегодня), days — на сколько вперёд (14).
     *
     * Ближайшие строки платёжного календаря: что придёт и что платить.
     */
    public function upcomingPayments(Request $request)
    {
        $this->initTenant($request);

        $from = $request->date ? Carbon::parse($request->date)->startOfDay() : Carbon::today();
        $days = max(1, min((int) ($request->days ?: 14), 60));
        $to   = $from->copy()->addDays($days - 1);

        if (!$this->budgetVisible($request)) {
            return response()->json(['available' => false, 'reason' => 'forbidden']);
        }

        $docIds = DB::connection($this->dbName)->table('budget_documents')
            ->whereNull('deleted_at')
            ->where('type', 'pdc')
            ->where('status', '!=', 'archived')
            ->where('period_to', '>=', $from->toDateString())
            ->where('period_from', '<=', $to->toDateString())
            ->pluck('id');

        if ($docIds->isEmpty()) {
            return response()->json(['available' => false, 'reason' => 'no_calendar']);
        }

        $base = fn() => DB::connection($this->dbName)->table('budget_items as bi')
            ->whereIn('bi.budget_document_id', $docIds->all())
            ->where('bi.period_date', '>=', $from->toDateString())
            ->where('bi.period_date', '<=', $to->toDateString());

        $rows = $base()
            ->leftJoin('info as i', 'i.id', '=', 'bi.article_id')
            ->orderBy('bi.period_date')->orderByDesc(DB::raw('ABS(bi.amount)'))
            ->limit(8)
            ->get(['bi.id', 'bi.period_date', 'bi.amount', 'bi.content', 'i.name as article']);

        $sum = $base()->selectRaw(
            'SUM(CASE WHEN bi.amount > 0 THEN bi.amount ELSE 0 END) as inflow, ' .
            'SUM(CASE WHEN bi.amount < 0 THEN -bi.amount ELSE 0 END) as outflow, COUNT(*) as cnt'
        )->first();

        return response()->json([
            'available' => true,
            'date_from' => $from->toDateString(),
            'date_to'   => $to->toDateString(),
            'inflow'    => round((float) ($sum->inflow ?? 0), 2),
            'outflow'   => round((float) ($sum->outflow ?? 0), 2),
            'count'     => (int) ($sum->cnt ?? 0),
            'items'     => $rows->map(fn($r) => [
                'id'      => (int) $r->id,
                'date'    => Carbon::parse($r->period_date)->toDateString(),
                'amount'  => round((float) $r->amount, 2),
                'title'   => $r->content ?: ($r->article ?: 'Платёж'),
                'article' => $r->article,
            ])->all(),
        ]);
    }

    /**
     * Счета показателей с оглядкой на закрытые.
     *
     * Закрытый счёт не превращается в ноль: ноль — это утверждение «выручки не
     * было», и человек начнёт его проверять. Закрытый показатель отдаём как
     * null, плитка покажет прочерк.
     */
    private function metricAccounts(): array
    {
        $biIds = DB::connection($this->dbName)
            ->table('balance_items')
            ->whereIn('code', [self::REVENUE_CODE, self::COGS_CODE, self::EXPENSES_CODE])
            ->pluck('id', 'code');

        $rev  = isset($biIds[self::REVENUE_CODE])  ? (int) $biIds[self::REVENUE_CODE]  : null;
        $cogs = isset($biIds[self::COGS_CODE])     ? (int) $biIds[self::COGS_CODE]     : null;
        $exp  = isset($biIds[self::EXPENSES_CODE]) ? (int) $biIds[self::EXPENSES_CODE] : null;

        $revHidden  = $this->scope->hides($rev);
        $cogsHidden = $this->scope->hides($cogs);
        $expHidden  = $this->scope->hides($exp);

        return [
            'rev'         => $revHidden  ? null : $rev,
            'cogs'        => $cogsHidden ? null : $cogs,
            'exp'         => $expHidden  ? null : $exp,
            'rev_hidden'  => $revHidden,
            'cogs_hidden' => $cogsHidden,
            'exp_hidden'  => $expHidden,
        ];
    }

    /** Построить {total, by_project} по показателям за период. */
    private function buildMetrics(array $acc, Carbon $from, Carbon $to, ?int $projectFilter, $projectNames): array
    {
        [$revBi, $cogsBi] = [$acc['rev'], $acc['cogs']];

        $metrics = [];
        foreach ($this->metricsByProject($revBi, $cogsBi, $from, $to, $projectFilter, $acc['exp'] ?? null) as $r) {
            $metrics[(int) $r->project_id] = [
                'revenue' => (float) $r->revenue, 'cogs' => (float) $r->cogs, 'expenses' => (float) $r->expenses,
            ];
        }

        $revHidden  = $acc['rev_hidden'];
        $cogsHidden = $acc['cogs_hidden'];
        $expHidden  = $acc['exp_hidden'] ?? false;
        // Прибыль складывается из трёх счетов: закрыт хоть один — её не
        // показываем, иначе по ней вычислялся бы закрытый показатель
        $profitHidden = $revHidden || $cogsHidden || $expHidden;

        $byProject = [];
        $totRevenue = 0.0;
        $totCogs    = 0.0;
        $totExp     = 0.0;
        foreach ($metrics as $pid => $vals) {
            $revenue = round($vals['revenue'], 2);
            $cogs    = round($vals['cogs'], 2);
            $exp     = round($vals['expenses'], 2);
            $byProject[] = [
                'project_id' => $pid,
                'name'       => $projectNames[$pid] ?? ('#' . $pid),
                'revenue'    => $revHidden  ? null : $revenue,
                'cogs'       => $cogsHidden ? null : $cogs,
                'foodcost'   => ($revHidden || $cogsHidden) ? null : $this->foodcost($cogs, $revenue),
                'expenses'   => $expHidden ? null : $exp,
                'gross'      => ($revHidden || $cogsHidden) ? null : round($revenue - $cogs, 2),
                'profit'     => $profitHidden ? null : round($revenue - $cogs - $exp, 2),
            ];
            $totRevenue += $revenue;
            $totCogs    += $cogs;
            $totExp     += $exp;
        }

        usort($byProject, fn($a, $b) => ($b['revenue'] ?? 0) <=> ($a['revenue'] ?? 0));

        return [
            'total' => [
                'revenue'  => $revHidden  ? null : round($totRevenue, 2),
                'cogs'     => $cogsHidden ? null : round($totCogs, 2),
                'foodcost' => ($revHidden || $cogsHidden) ? null : $this->foodcost($totCogs, $totRevenue),
                'expenses' => $expHidden ? null : round($totExp, 2),
                // Валовая — выручка за вычетом себестоимости; прибыль — ещё и
                // за вычетом расходов периода
                'gross'    => ($revHidden || $cogsHidden) ? null : round($totRevenue - $totCogs, 2),
                'profit'   => $profitHidden ? null : round($totRevenue - $totCogs - $totExp, 2),
            ],
            'revenue_hidden' => $revHidden,
            'cogs_hidden'    => $cogsHidden,
            'by_project'     => $byProject,
        ];
    }

    /**
     * GET /dashboard/revenue-series
     *   date, days (по умолчанию 30, макс 90), project_id — как в summary.
     *
     * Дневной ряд выручки по проектам для графиков: по оси X — дни,
     * по оси Y — выручка, отдельная линия на проект.
     */
    public function revenueSeries(Request $request)
    {
        $this->initTenant($request);

        $projectFilter = $request->project_id ? (int) $request->project_id : null;

        // Диапазон: date_from/date_to (приоритет) или date+days (обратная совместимость).
        if ($request->date_from && $request->date_to) {
            $from   = Carbon::parse($request->date_from)->startOfDay();
            $anchor = Carbon::parse($request->date_to)->startOfDay();
            if ($anchor->lt($from)) { [$from, $anchor] = [$anchor, $from]; }
        } else {
            $days   = max(1, min((int) ($request->days ?: 30), 400));
            $anchor = $request->date ? Carbon::parse($request->date)->startOfDay() : Carbon::yesterday();
            $from   = $anchor->copy()->subDays($days - 1);
        }
        // Ограничение числа точек графика
        if ($from->diffInDays($anchor) > 400) { $from = $anchor->copy()->subDays(400); }

        $revenueBiId = $this->metricAccounts()['rev'];

        // Список всех дней периода (для выравнивания и нулей)
        $dayList = [];
        for ($d = $from->copy(); $d->lte($anchor); $d->addDay()) {
            $dayList[] = $d->toDateString();
        }
        $dayIndex = array_flip($dayList);

        $projectNames = DB::connection($this->dbName)
            ->table('projects')->whereNull('deleted_at')->pluck('name', 'id');

        $series = [];  // pid => [день => выручка]
        $totals = [];  // pid => сумма за период

        if ($revenueBiId) {
            $rows = DB::connection($this->dbName)
                ->table('balance_changes')
                ->where('bi_id', $revenueBiId)
                ->where('date', '>=', $from->toDateString() . ' 00:00:00')
                ->where('date', '<=', $anchor->toDateString() . ' 23:59:59')
                ->when($projectFilter, fn($q) => $q->where('project_id', $projectFilter))
                ->groupBy(DB::raw('DATE(`date`)'), 'project_id')
                ->select(DB::raw('DATE(`date`) as d'), 'project_id', DB::raw('SUM(amount) as s'))
                ->get();

            foreach ($rows as $r) {
                $idx = $dayIndex[$r->d] ?? null;
                if ($idx === null) continue;
                $pid = (int) $r->project_id;
                $rev = (float) -$r->s;
                if (!isset($series[$pid])) {
                    $series[$pid] = array_fill(0, count($dayList), 0.0);
                }
                $series[$pid][$idx] += round($rev, 2);
                $totals[$pid] = ($totals[$pid] ?? 0.0) + $rev;
            }
        }

        // Проекты — по убыванию суммы (для порядка в легенде)
        arsort($totals);
        $projects = [];
        foreach (array_keys($totals) as $pid) {
            $projects[] = [
                'id'    => $pid,
                'name'  => $projectNames[$pid] ?? ('#' . $pid),
                'total' => round($totals[$pid], 2),
            ];
        }

        $seriesOut = [];
        foreach ($series as $pid => $vals) {
            $seriesOut[(string) $pid] = array_map(fn($v) => round($v, 2), $vals);
        }

        return response()->json([
            'date_from' => $from->toDateString(),
            'date_to'   => $anchor->toDateString(),
            'days'      => $dayList,
            'projects'  => $projects,
            'series'    => $seriesOut,
            // Счёт выручки закрыт — график пуст не потому, что продаж не было
            'revenue_hidden' => $this->metricAccounts()['rev_hidden'],
        ]);
    }

    /** Показатели, которые умеет рисовать график динамики */
    private const TREND_INDICATORS = ['revenue', 'cogs', 'expenses', 'gross', 'profit'];

    /**
     * GET /dashboard/indicator-series
     *   date_from, date_to, project_id
     *   step        — day | month | auto (по умолчанию: дольше двух месяцев — по месяцам)
     *   indicators  — список из TREND_INDICATORS (по умолчанию revenue)
     *   compare     — none | prev | year: второй ряд для сравнения
     *
     * Ряды показателей по дням или месяцам — итогом по выбранным проектам.
     * Ряд сравнения выровнен по порядковому номеру точки: 1-е число с 1-м,
     * январь с январём — так «ноябрь против октября» и «2026 против 2025»
     * ложатся друг на друга, хотя в месяцах разное число дней.
     */
    public function indicatorSeries(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'date_from'    => 'required|date',
            'date_to'      => 'required|date',
            'step'         => 'nullable|in:day,month,auto',
            'compare'      => 'nullable|in:none,prev,year',
            'indicators'   => 'nullable|array',
            'indicators.*' => 'in:' . implode(',', self::TREND_INDICATORS),
        ]);
        $projectFilter = $request->project_id ? (int) $request->project_id : null;

        $from = Carbon::parse($data['date_from'])->startOfDay();
        $to   = Carbon::parse($data['date_to'])->startOfDay();
        if ($to->lt($from)) { [$from, $to] = [$to, $from]; }

        $step = $data['step'] ?? 'auto';
        if ($step === 'auto') {
            $step = $from->diffInDays($to) > 62 ? 'month' : 'day';
        }
        // Потолок точек: 400 дней или 120 месяцев
        if ($step === 'day' && $from->diffInDays($to) > 400) {
            $from = $to->copy()->subDays(400);
        }
        if ($step === 'month') {
            $from = $from->copy()->startOfMonth();
            $to   = $to->copy()->endOfMonth()->startOfDay();
            if ($from->diffInMonths($to) > 119) {
                $from = $to->copy()->startOfMonth()->subMonths(119);
            }
        }

        $indicators = array_values(array_unique($data['indicators'] ?? ['revenue']));
        $acc = $this->metricAccounts();

        $current = $this->trendBuckets($acc, $from, $to, $step, $projectFilter, $indicators);

        $compareOut = null;
        $compare = $data['compare'] ?? 'none';
        if ($compare !== 'none') {
            [$cFrom, $cTo] = $compare === 'year'
                ? [$from->copy()->subYearNoOverflow(), $to->copy()->subYearNoOverflow()]
                : $this->previousRange($from, $to);
            if ($step === 'month') {
                // По месяцам сравниваем столько же месяцев, сколько в периоде
                $months = count($current['points']);
                $cFrom = $cFrom->copy()->startOfMonth();
                if ($compare === 'prev') $cFrom = $from->copy()->subMonthsNoOverflow($months);
                $cTo = $cFrom->copy()->addMonthsNoOverflow($months - 1)->endOfMonth()->startOfDay();
            }
            $compareOut = array_merge(
                ['mode' => $compare, 'date_from' => $cFrom->toDateString(), 'date_to' => $cTo->toDateString()],
                $this->trendBuckets($acc, $cFrom, $cTo, $step, $projectFilter, $indicators),
            );
        }

        return response()->json(array_merge(
            ['date_from' => $from->toDateString(), 'date_to' => $to->toDateString(), 'step' => $step],
            $current,
            [
                'compare' => $compareOut,
                // Закрытые счета: ряд не рисуем и говорим почему, а не рисуем «ноль»
                'hidden'  => array_values(array_filter($indicators, fn ($k) => $this->trendHidden($acc, $k))),
            ],
        ));
    }

    /** Закрыт ли показатель ролью — по тем же правилам, что и плитки */
    private function trendHidden(array $acc, string $key): bool
    {
        return match ($key) {
            'revenue'  => $acc['rev_hidden'],
            'cogs'     => $acc['cogs_hidden'],
            'expenses' => $acc['exp_hidden'],
            'gross'    => $acc['rev_hidden'] || $acc['cogs_hidden'],
            'profit'   => $acc['rev_hidden'] || $acc['cogs_hidden'] || $acc['exp_hidden'],
            default    => true,
        };
    }

    /**
     * Точки периода и значения показателей в них.
     *
     * @return array{points: string[], series: array<string, (float[]|null)>}
     */
    private function trendBuckets(array $acc, Carbon $from, Carbon $to, string $step, ?int $projectFilter, array $indicators): array
    {
        $points = [];
        if ($step === 'month') {
            for ($d = $from->copy()->startOfMonth(); $d->lte($to); $d->addMonthNoOverflow()) {
                $points[] = $d->format('Y-m');
            }
        } else {
            for ($d = $from->copy(); $d->lte($to); $d->addDay()) {
                $points[] = $d->toDateString();
            }
        }
        $index = array_flip($points);
        $zero  = array_fill(0, count($points), 0.0);
        $raw   = ['revenue' => $zero, 'cogs' => $zero, 'expenses' => $zero];

        $biIds = array_values(array_filter([$acc['rev'], $acc['cogs'], $acc['exp']]));
        if ($biIds) {
            $bucket = $step === 'month' ? "DATE_FORMAT(`date`, '%Y-%m')" : 'DATE(`date`)';
            $rows = DB::connection($this->dbName)
                ->table('balance_changes')
                ->whereIn('bi_id', $biIds)
                ->where('date', '>=', $from->toDateString() . ' 00:00:00')
                ->where('date', '<=', $to->toDateString() . ' 23:59:59')
                ->when($projectFilter, fn ($q) => $q->where('project_id', $projectFilter))
                ->groupBy(DB::raw($bucket), 'bi_id')
                ->select(DB::raw("$bucket as p"), 'bi_id', DB::raw('SUM(amount) as s'))
                ->get();

            foreach ($rows as $r) {
                $i = $index[$r->p] ?? null;
                if ($i === null) continue;
                $bi = (int) $r->bi_id;
                // Выручка — кредитовый оборот (в balance_changes с минусом),
                // себестоимость и расходы — дебетовый
                if ($bi === $acc['rev'])  $raw['revenue'][$i]  += -(float) $r->s;
                if ($bi === $acc['cogs']) $raw['cogs'][$i]     += (float) $r->s;
                if ($bi === $acc['exp'])  $raw['expenses'][$i] += (float) $r->s;
            }
        }

        $series = [];
        foreach ($indicators as $k) {
            if ($this->trendHidden($acc, $k)) { $series[$k] = null; continue; }
            $series[$k] = array_map(fn ($i) => round(match ($k) {
                'revenue'  => $raw['revenue'][$i],
                'cogs'     => $raw['cogs'][$i],
                'expenses' => $raw['expenses'][$i],
                'gross'    => $raw['revenue'][$i] - $raw['cogs'][$i],
                'profit'   => $raw['revenue'][$i] - $raw['cogs'][$i] - $raw['expenses'][$i],
            }, 2), array_keys($points));
        }

        return ['points' => $points, 'series' => $series];
    }

    // ─── Раскладка дашборда (виджеты), персонально на пользователя ───────

    private function layoutKey(Request $request): string
    {
        return 'dashboard_layout:' . ($this->currentUserId($request) ?? 0);
    }

    // GET /dashboard/layout
    public function getLayout(Request $request)
    {
        $this->initTenant($request);

        $value = DB::connection($this->dbName)
            ->table('settings')
            ->where('key', $this->layoutKey($request))
            ->value('value');

        return response()->json(['layout' => $value ? json_decode($value, true) : null]);
    }

    // PUT /dashboard/layout
    public function saveLayout(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'layout'           => 'required|array',
            'layout.widgets'   => 'present|array',
        ]);

        DB::connection($this->dbName)->table('settings')->updateOrInsert(
            ['key' => $this->layoutKey($request)],
            [
                'value'      => json_encode($data['layout'], JSON_UNESCAPED_UNICODE),
                'updated_at' => now(),
                'created_at' => now(),
            ]
        );

        return response()->json(['layout' => $data['layout']]);
    }

    /**
     * Показатели за период в разрезе проектов одним запросом:
     *   revenue = нетто-оборот по кредиту доходов (П587), -SUM(amount)
     *   cogs    = нетто-оборот по дебету себестоимости (П588), +SUM(amount)
     */
    private function metricsByProject(?int $revBi, ?int $cogsBi, Carbon $from, Carbon $to, ?int $projectFilter, ?int $expBi = null)
    {
        $biIds = array_values(array_filter([$revBi, $cogsBi, $expBi]));
        if (empty($biIds)) {
            return collect();
        }

        $revExpr  = $revBi  ? 'SUM(CASE WHEN bi_id = ' . (int) $revBi  . ' THEN -amount ELSE 0 END)' : '0';
        $cogsExpr = $cogsBi ? 'SUM(CASE WHEN bi_id = ' . (int) $cogsBi . ' THEN amount ELSE 0 END)'  : '0';
        $expExpr  = $expBi  ? 'SUM(CASE WHEN bi_id = ' . (int) $expBi  . ' THEN amount ELSE 0 END)'  : '0';

        return DB::connection($this->dbName)
            ->table('balance_changes')
            ->whereIn('bi_id', $biIds)
            ->where('date', '>=', $from->toDateString() . ' 00:00:00')
            ->where('date', '<=', $to->toDateString() . ' 23:59:59')
            ->when($projectFilter, fn($q) => $q->where('project_id', $projectFilter))
            ->groupBy('project_id')
            ->select('project_id', DB::raw("$revExpr as revenue"), DB::raw("$cogsExpr as cogs"), DB::raw("$expExpr as expenses"))
            ->get();
    }

    /** Фудкост, % = себестоимость / выручка × 100 (0 при нулевой выручке). */
    private function foodcost(float $cogs, float $revenue): float
    {
        return $revenue != 0.0 ? round($cogs / $revenue * 100, 1) : 0.0;
    }
}
