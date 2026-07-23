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

    public function summary(Request $request)
    {
        $this->initTenant($request);

        $projectFilter = $request->project_id ? (int) $request->project_id : null;

        // Опорная дата: выбранная или вчера.
        $anchor = $request->date
            ? Carbon::parse($request->date)->startOfDay()
            : Carbon::yesterday();

        $revenueBiId = DB::connection($this->dbName)
            ->table('balance_items')
            ->where('code', self::REVENUE_CODE)
            ->value('id');

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
            // metrics[project_id] = ['revenue' => float]
            $metrics = [];

            if ($revenueBiId) {
                $rows = $this->revenueByProject($revenueBiId, $w['from'], $anchor, $projectFilter);
                foreach ($rows as $r) {
                    $metrics[(int) $r->project_id]['revenue'] = (float) -$r->sum_amount;
                }
            }

            $byProject = [];
            $total = ['revenue' => 0.0];
            foreach ($metrics as $pid => $vals) {
                $revenue = round($vals['revenue'] ?? 0.0, 2);
                $byProject[] = [
                    'project_id' => $pid,
                    'name'       => $projectNames[$pid] ?? ('#' . $pid),
                    'revenue'    => $revenue,
                ];
                $total['revenue'] += $revenue;
            }
            $total['revenue'] = round($total['revenue'], 2);

            // Крупные проекты — вверху разбивки.
            usort($byProject, fn($a, $b) => $b['revenue'] <=> $a['revenue']);

            $periods[$key] = [
                'label'      => $w['label'],
                'date_from'  => $w['from']->toDateString(),
                'date_to'    => $anchor->toDateString(),
                'total'      => $total,
                'by_project' => $byProject,
            ];
        }

        return response()->json([
            'reference_date' => $anchor->toDateString(),
            'multi_project'  => $projectNames->count() > 1,
            'periods'        => $periods,
        ]);
    }

    /** Нетто-оборот по кредиту счёта за период в разрезе проектов. */
    private function revenueByProject(int $biId, Carbon $from, Carbon $to, ?int $projectFilter)
    {
        return DB::connection($this->dbName)
            ->table('balance_changes')
            ->where('bi_id', $biId)
            ->where('date', '>=', $from->toDateString() . ' 00:00:00')
            ->where('date', '<=', $to->toDateString() . ' 23:59:59')
            ->when($projectFilter, fn($q) => $q->where('project_id', $projectFilter))
            ->groupBy('project_id')
            ->select('project_id', DB::raw('SUM(amount) as sum_amount'))
            ->get();
    }
}
