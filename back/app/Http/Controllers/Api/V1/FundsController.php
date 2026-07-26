<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Support\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Калькулятор план/факт по выбранной модели распределения (fund_schemes).
 *
 * Доход и расход берутся ПО ФАКТУ из движений денег (счета info_1_type='cash',
 * статья ДДС — в info_2_id):
 *   поступления  = приход (amount > 0) по scheme.income_flow_ids;
 *   расход фонда = списание (amount < 0) по fund.flow_info_ids.
 *
 * Накопление от scheme.start_date:
 *   остаток фонда = opening_balance + %·(поступления с start_date) − (потрачено с start_date).
 */
class FundsController extends TenantController
{
    private function db()
    {
        return DB::connection($this->dbName);
    }

    // GET /funds/calc?scheme_id=&week_start=YYYY-MM-DD
    public function calc(Request $request)
    {
        $this->initTenant($request);
        $request->validate([
            'scheme_id'  => 'required|integer',
            'week_start' => 'required|date',
        ]);

        $scheme = $this->db()->table('fund_schemes')
            ->where('id', $request->scheme_id)->whereNull('deleted_at')->first();
        if (!$scheme) return response()->json(['message' => 'Модель не найдена'], 404);

        $funds = $this->db()->table('funds')->where('scheme_id', $scheme->id)->orderBy('sort_order')->get();

        $weekStart = Carbon::parse($request->week_start)->startOfDay();
        $weekEnd   = $weekStart->copy()->addDays(6);
        $start     = $scheme->start_date ? Carbon::parse($scheme->start_date)->startOfDay() : $weekStart->copy();
        $priorEnd  = $weekStart->copy()->subDay();

        $cashBiIds  = $this->db()->table('balance_items')->where('info_1_type', 'cash')->pluck('id')->all();
        $incomeArts = array_map('intval', json_decode($scheme->income_flow_ids ?? '[]', true) ?: []);

        $incomePrior = $this->flow($cashBiIds, $incomeArts, $start, $priorEnd, 'in');
        $incomeWeek  = $this->flow($cashBiIds, $incomeArts, $weekStart, $weekEnd, 'in');

        $fundRows = $funds->map(function ($f) use ($cashBiIds, $start, $priorEnd, $weekStart, $weekEnd) {
            $arts = array_map('intval', json_decode($f->flow_info_ids ?? '[]', true) ?: []);
            return [
                'id'              => $f->id,
                'name'            => $f->name,
                'percent'         => (float) $f->percent,
                'opening_balance' => (float) $f->opening_balance,
                'spent_prior'     => $this->flow($cashBiIds, $arts, $start, $priorEnd, 'out'),
                'spent_week'      => $this->flow($cashBiIds, $arts, $weekStart, $weekEnd, 'out'),
            ];
        })->values();

        $cashActual = empty($cashBiIds) ? 0.0 : (float) $this->db()->table('balance_changes')
            ->whereIn('bi_id', $cashBiIds)
            ->where('date', '<=', $weekEnd->toDateString() . ' 23:59:59')
            ->sum('amount');

        return response()->json([
            'scheme_id'    => $scheme->id,
            'scheme_name'  => $scheme->name,
            'week_start'   => $weekStart->toDateString(),
            'week_end'     => $weekEnd->toDateString(),
            'start_date'   => $start->toDateString(),
            'income_prior' => round($incomePrior, 2),
            'income_week'  => round($incomeWeek, 2),
            'cash_actual'  => round($cashActual, 2),
            'funds'        => $fundRows,
        ]);
    }

    /** Движение по кассовым счетам за период по статьям ДДС. dir: 'in' | 'out' (положительное). */
    private function flow(array $cashBiIds, array $articleIds, Carbon $from, Carbon $to, string $dir): float
    {
        if (empty($cashBiIds) || empty($articleIds) || $from->gt($to)) return 0.0;

        $q = $this->db()->table('balance_changes')
            ->whereIn('bi_id', $cashBiIds)
            ->whereIn('info_2_id', $articleIds)
            ->where('date', '>=', $from->toDateString() . ' 00:00:00')
            ->where('date', '<=', $to->toDateString() . ' 23:59:59');

        if ($dir === 'in') {
            return round((float) $q->where('amount', '>', 0)->sum('amount'), 2);
        }
        return round((float) -$q->where('amount', '<', 0)->sum('amount'), 2);
    }
}
