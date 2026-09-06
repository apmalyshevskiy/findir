<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

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

        return response()->json(array_merge(
            ['date_from' => $from->toDateString(), 'date_to' => $to->toDateString()],
            $this->buildMetrics($this->metricAccounts(), $from, $to, $projectFilter, $projectNames)
        ));
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
            ->whereIn('code', [self::REVENUE_CODE, self::COGS_CODE])
            ->pluck('id', 'code');

        $rev  = isset($biIds[self::REVENUE_CODE]) ? (int) $biIds[self::REVENUE_CODE] : null;
        $cogs = isset($biIds[self::COGS_CODE])    ? (int) $biIds[self::COGS_CODE]    : null;

        $revHidden  = $this->scope->hides($rev);
        $cogsHidden = $this->scope->hides($cogs);

        return [
            'rev'         => $revHidden  ? null : $rev,
            'cogs'        => $cogsHidden ? null : $cogs,
            'rev_hidden'  => $revHidden,
            'cogs_hidden' => $cogsHidden,
        ];
    }

    /** Построить {total, by_project} по показателям за период. */
    private function buildMetrics(array $acc, Carbon $from, Carbon $to, ?int $projectFilter, $projectNames): array
    {
        [$revBi, $cogsBi] = [$acc['rev'], $acc['cogs']];

        $metrics = [];
        foreach ($this->metricsByProject($revBi, $cogsBi, $from, $to, $projectFilter) as $r) {
            $metrics[(int) $r->project_id] = ['revenue' => (float) $r->revenue, 'cogs' => (float) $r->cogs];
        }

        $revHidden  = $acc['rev_hidden'];
        $cogsHidden = $acc['cogs_hidden'];

        $byProject = [];
        $totRevenue = 0.0;
        $totCogs    = 0.0;
        foreach ($metrics as $pid => $vals) {
            $revenue = round($vals['revenue'], 2);
            $cogs    = round($vals['cogs'], 2);
            $byProject[] = [
                'project_id' => $pid,
                'name'       => $projectNames[$pid] ?? ('#' . $pid),
                'revenue'    => $revHidden  ? null : $revenue,
                'cogs'       => $cogsHidden ? null : $cogs,
                'foodcost'   => ($revHidden || $cogsHidden) ? null : $this->foodcost($cogs, $revenue),
            ];
            $totRevenue += $revenue;
            $totCogs    += $cogs;
        }

        usort($byProject, fn($a, $b) => ($b['revenue'] ?? 0) <=> ($a['revenue'] ?? 0));

        return [
            'total' => [
                'revenue'  => $revHidden  ? null : round($totRevenue, 2),
                'cogs'     => $cogsHidden ? null : round($totCogs, 2),
                'foodcost' => ($revHidden || $cogsHidden) ? null : $this->foodcost($totCogs, $totRevenue),
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
    private function metricsByProject(?int $revBi, ?int $cogsBi, Carbon $from, Carbon $to, ?int $projectFilter)
    {
        $biIds = array_values(array_filter([$revBi, $cogsBi]));
        if (empty($biIds)) {
            return collect();
        }

        $revExpr  = $revBi  ? 'SUM(CASE WHEN bi_id = ' . (int) $revBi  . ' THEN -amount ELSE 0 END)' : '0';
        $cogsExpr = $cogsBi ? 'SUM(CASE WHEN bi_id = ' . (int) $cogsBi . ' THEN amount ELSE 0 END)'  : '0';

        return DB::connection($this->dbName)
            ->table('balance_changes')
            ->whereIn('bi_id', $biIds)
            ->where('date', '>=', $from->toDateString() . ' 00:00:00')
            ->where('date', '<=', $to->toDateString() . ' 23:59:59')
            ->when($projectFilter, fn($q) => $q->where('project_id', $projectFilter))
            ->groupBy('project_id')
            ->select('project_id', DB::raw("$revExpr as revenue"), DB::raw("$cogsExpr as cogs"))
            ->get();
    }

    /** Фудкост, % = себестоимость / выручка × 100 (0 при нулевой выручке). */
    private function foodcost(float $cogs, float $revenue): float
    {
        return $revenue != 0.0 ? round($cogs / $revenue * 100, 1) : 0.0;
    }
}
