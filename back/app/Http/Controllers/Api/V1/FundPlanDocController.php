<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Support\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Акт финансового планирования (fund_plan_docs + fund_plan_lines).
 *
 * По каждому фонду в строках акта указываются планируемые расходы:
 * статья ДДС + сумма + комментарий.
 *
 * Переходящий остаток фонда на начало недели считается из прошлых актов:
 *   остаток = opening_balance + %·(поступления с start_date) − (запланировано в актах прошлых недель).
 */
class FundPlanDocController extends TenantController
{
    private function db()
    {
        return DB::connection($this->dbName);
    }

    // GET /fund-plan-docs?scheme_id=&week_start=
    public function show(Request $request)
    {
        $this->initTenant($request);
        $request->validate(['scheme_id' => 'required|integer', 'week_start' => 'required|date']);

        $scheme = $this->db()->table('fund_schemes')->where('id', $request->scheme_id)->whereNull('deleted_at')->first();
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

        // Запланировано в акте прошлой недели (для сравнения план/факт), по фондам
        $prevWeekStart = $weekStart->copy()->subDays(7)->toDateString();
        $plannedPrev = $this->db()->table('fund_plan_lines as l')
            ->join('fund_plan_docs as d', 'd.id', '=', 'l.doc_id')
            ->where('d.scheme_id', $scheme->id)->whereNull('d.deleted_at')
            ->where('d.week_start', $prevWeekStart)
            ->where('l.accepted', 1)
            ->groupBy('l.fund_id')
            ->select('l.fund_id', DB::raw('SUM(l.amount) as s'))
            ->pluck('s', 'l.fund_id');

        // Распределение прошлых недель с учётом процентов каждой недели (для переходящего остатка).
        // По умолчанию % = из модели; для недель, где в акте задано fund_percents — по акту.
        $overrideDocs = $this->db()->table('fund_plan_docs')
            ->where('scheme_id', $scheme->id)->whereNull('deleted_at')
            ->where('week_start', '<', $weekStart->toDateString())
            ->whereNotNull('fund_percents')
            ->get(['week_start', 'fund_percents']);

        $overrideIncome = 0.0;
        $overrideDist = [];  // fund_id => распределено за недели-исключения
        foreach ($overrideDocs as $od) {
            $ws = Carbon::parse($od->week_start)->startOfDay();
            $incW = $this->flow($cashBiIds, $incomeArts, $ws, $ws->copy()->addDays(6), 'in');
            $overrideIncome += $incW;
            $pcts = json_decode($od->fund_percents ?? '{}', true) ?: [];
            foreach ($funds as $f) {
                $p = isset($pcts[$f->id]) ? (float) $pcts[$f->id] : (float) $f->percent;
                $overrideDist[$f->id] = ($overrideDist[$f->id] ?? 0.0) + $incW * $p / 100;
            }
        }
        $nonOverrideIncome = $incomePrior - $overrideIncome;

        // Переходящий остаток = стартовый + распределено (с учётом % каждой недели) − факт списаний прошлых недель.
        $fundsOut = $funds->map(function ($f) use ($cashBiIds, $start, $priorEnd, $weekStart, $weekEnd, $plannedPrev, $overrideDist, $nonOverrideIncome) {
            $arts = array_map('intval', json_decode($f->flow_info_ids ?? '[]', true) ?: []);
            $spentPrior = $this->flow($cashBiIds, $arts, $start, $priorEnd, 'out');
            $distPrior  = ($overrideDist[$f->id] ?? 0.0) + (float) $f->percent / 100 * $nonOverrideIncome;
            return [
                'id'              => $f->id,
                'name'            => $f->name,
                'percent'         => (float) $f->percent,       // % из модели (дефолт)
                'opening_balance' => (float) $f->opening_balance,
                'flow_info_ids'   => $arts,
                'planned_prev'    => (float) ($plannedPrev[$f->id] ?? 0),
                'spent_week'      => $this->flow($cashBiIds, $arts, $weekStart, $weekEnd, 'out'),
                'carried_in'      => round((float) $f->opening_balance + $distPrior - $spentPrior, 2),
            ];
        })->values();

        $doc = $this->db()->table('fund_plan_docs')
            ->where('scheme_id', $scheme->id)->where('week_start', $weekStart->toDateString())
            ->whereNull('deleted_at')->first();

        $lines = $doc
            ? $this->db()->table('fund_plan_lines')->where('doc_id', $doc->id)->orderBy('sort_order')->get()
            : collect();

        return response()->json([
            'scheme_id'    => $scheme->id,
            'scheme_name'  => $scheme->name,
            'week_start'   => $weekStart->toDateString(),
            'week_end'     => $weekEnd->toDateString(),
            'income_prior' => round($incomePrior, 2),
            'income_week'  => round($incomeWeek, 2),
            'funds'        => $fundsOut,
            'doc'          => [
                'id'            => $doc->id ?? null,
                'status'        => $doc->status ?? 'draft',
                'note'          => $doc->note ?? null,
                'fund_percents' => $doc && $doc->fund_percents ? (json_decode($doc->fund_percents, true) ?: null) : null,
                'lines'  => $lines->map(fn($l) => [
                    'fund_id'      => $l->fund_id,
                    'flow_info_id' => $l->flow_info_id,
                    'amount'       => (float) $l->amount,
                    'comment'      => $l->comment,
                    'accepted'     => (bool) $l->accepted,
                ])->values(),
            ],
        ]);
    }

    // PUT /fund-plan-docs
    public function save(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'scheme_id'         => 'required|integer',
            'week_start'        => 'required|date',
            'status'            => 'nullable|string|in:draft,approved',
            'note'              => 'nullable|string|max:255',
            'fund_percents'     => 'nullable|array',
            'lines'             => 'present|array',
            'lines.*.fund_id'   => 'required|integer',
            'lines.*.flow_info_id' => 'nullable|integer',
            'lines.*.amount'    => 'required|numeric',
            'lines.*.comment'   => 'nullable|string|max:255',
            'lines.*.accepted'  => 'nullable|boolean',
        ]);

        $weekStart = Carbon::parse($data['week_start'])->toDateString();
        $percentsJson = !empty($data['fund_percents']) ? json_encode($data['fund_percents'], JSON_UNESCAPED_UNICODE) : null;

        $doc = $this->db()->table('fund_plan_docs')
            ->where('scheme_id', $data['scheme_id'])->where('week_start', $weekStart)
            ->whereNull('deleted_at')->first();

        if ($doc) {
            $docId = $doc->id;
            $this->db()->table('fund_plan_docs')->where('id', $docId)->update([
                'status'        => $data['status'] ?? $doc->status,
                'note'          => $data['note'] ?? null,
                'fund_percents' => $percentsJson,
                'updated_at'    => now(),
            ]);
        } else {
            $docId = $this->db()->table('fund_plan_docs')->insertGetId([
                'scheme_id'     => $data['scheme_id'],
                'week_start'    => $weekStart,
                'status'        => $data['status'] ?? 'draft',
                'note'          => $data['note'] ?? null,
                'fund_percents' => $percentsJson,
                'created_by'    => $this->currentUserId($request),
                'created_at'    => now(),
                'updated_at'    => now(),
            ]);
        }

        $this->db()->table('fund_plan_lines')->where('doc_id', $docId)->delete();
        $order = 0;
        foreach ($data['lines'] as $l) {
            $this->db()->table('fund_plan_lines')->insert([
                'doc_id'       => $docId,
                'fund_id'      => $l['fund_id'],
                'flow_info_id' => $l['flow_info_id'] ?? null,
                'amount'       => (float) $l['amount'],
                'comment'      => $l['comment'] ?? null,
                'accepted'     => !empty($l['accepted']),
                'sort_order'   => $order++,
                'created_at'   => now(),
                'updated_at'   => now(),
            ]);
        }

        return $this->show($request);
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
