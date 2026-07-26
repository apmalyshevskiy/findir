<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Модель распределения (fund_schemes) и её фонды (funds).
 * Правила: сумма процентов = 100; статьи ДДС не пересекаются между фондами модели.
 */
class FundSchemeController extends TenantController
{
    private function db()
    {
        return DB::connection($this->dbName);
    }

    // GET /fund-schemes
    public function index(Request $request)
    {
        $this->initTenant($request);

        $schemes = $this->db()->table('fund_schemes')->whereNull('deleted_at')->orderBy('name')->get();
        $agg = $this->db()->table('funds')->whereNull('deleted_at')
            ->select('scheme_id', DB::raw('COUNT(*) as c'), DB::raw('SUM(percent) as p'))
            ->groupBy('scheme_id')->get()->keyBy('scheme_id');

        return response()->json([
            'data' => $schemes->map(fn($s) => [
                'id'             => $s->id,
                'name'           => $s->name,
                'is_active'      => (bool) $s->is_active,
                'week_start_dow' => (int) $s->week_start_dow,
                'start_date'     => $s->start_date,
                'funds_count'    => (int) ($agg[$s->id]->c ?? 0),
                'percent_sum'    => (float) ($agg[$s->id]->p ?? 0),
            ])->values(),
        ]);
    }

    // GET /fund-schemes/{id}
    public function show(Request $request, int $id)
    {
        $this->initTenant($request);
        $scheme = $this->loadScheme($id);
        if (!$scheme) return response()->json(['message' => 'Модель не найдена'], 404);
        return response()->json(['data' => $scheme]);
    }

    // POST /fund-schemes
    public function store(Request $request)
    {
        $this->initTenant($request);
        $data = $this->validated($request);
        if ($err = $this->fundsError($data['funds'])) {
            return response()->json(['message' => $err], 422);
        }

        $id = $this->db()->table('fund_schemes')->insertGetId([
            'name'            => $data['name'],
            'note'            => $data['note'] ?? null,
            'week_start_dow'  => $data['week_start_dow'] ?? 5,
            'start_date'      => $data['start_date'] ?? null,
            'income_flow_ids' => json_encode(array_map('intval', $data['income_flow_ids'] ?? [])),
            'is_active'       => true,
            'created_at'      => now(),
            'updated_at'      => now(),
        ]);
        $this->replaceFunds($id, $data['funds']);

        return response()->json(['data' => $this->loadScheme($id)], 201);
    }

    // PUT /fund-schemes/{id}
    public function update(Request $request, int $id)
    {
        $this->initTenant($request);
        if (!$this->loadScheme($id)) return response()->json(['message' => 'Модель не найдена'], 404);

        $data = $this->validated($request);
        if ($err = $this->fundsError($data['funds'])) {
            return response()->json(['message' => $err], 422);
        }

        $this->db()->table('fund_schemes')->where('id', $id)->update([
            'name'            => $data['name'],
            'note'            => $data['note'] ?? null,
            'week_start_dow'  => $data['week_start_dow'] ?? 5,
            'start_date'      => $data['start_date'] ?? null,
            'income_flow_ids' => json_encode(array_map('intval', $data['income_flow_ids'] ?? [])),
            'updated_at'      => now(),
        ]);
        $this->replaceFunds($id, $data['funds']);

        return response()->json(['data' => $this->loadScheme($id)]);
    }

    // DELETE /fund-schemes/{id}
    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);
        $this->db()->table('fund_schemes')->where('id', $id)->update(['deleted_at' => now()]);
        $this->db()->table('funds')->where('scheme_id', $id)->delete();
        return response()->json(['message' => 'Модель удалена']);
    }

    // ── helpers ──

    private function validated(Request $request): array
    {
        return $request->validate([
            'name'                    => 'required|string|max:150',
            'note'                    => 'nullable|string|max:255',
            'week_start_dow'          => 'nullable|integer|min:0|max:6',
            'start_date'              => 'nullable|date',
            'income_flow_ids'         => 'present|array',
            'income_flow_ids.*'       => 'integer',
            'funds'                   => 'required|array|min:1',
            'funds.*.name'            => 'required|string|max:100',
            'funds.*.percent'         => 'required|numeric|min:0|max:100',
            'funds.*.flow_info_ids'   => 'present|array',
            'funds.*.flow_info_ids.*' => 'integer',
            'funds.*.opening_balance' => 'nullable|numeric',
        ]);
    }

    /** Проверка бизнес-правил: сумма = 100, статьи ДДС не пересекаются. */
    private function fundsError(array $funds): ?string
    {
        $sum = 0.0;
        $seen = [];
        foreach ($funds as $f) {
            $sum += (float) ($f['percent'] ?? 0);
            foreach ($f['flow_info_ids'] ?? [] as $id) {
                $id = (int) $id;
                if (isset($seen[$id])) {
                    $name = $this->db()->table('info')->where('id', $id)->value('name') ?? ('#' . $id);
                    return "Статья ДДС «{$name}» привязана к нескольким фондам — статьи не должны пересекаться.";
                }
                $seen[$id] = true;
            }
        }
        if (abs($sum - 100) > 0.01) {
            return 'Сумма процентов по фондам должна быть 100% (сейчас ' . rtrim(rtrim(number_format($sum, 2, '.', ''), '0'), '.') . '%).';
        }
        return null;
    }

    private function replaceFunds(int $schemeId, array $funds): void
    {
        $this->db()->table('funds')->where('scheme_id', $schemeId)->delete();
        $order = 0;
        foreach ($funds as $f) {
            $this->db()->table('funds')->insert([
                'scheme_id'       => $schemeId,
                'name'            => $f['name'],
                'percent'         => (float) $f['percent'],
                'flow_info_ids'   => json_encode(array_map('intval', $f['flow_info_ids'] ?? [])),
                'opening_balance' => (float) ($f['opening_balance'] ?? 0),
                'sort_order'      => $order++,
                'created_at'      => now(),
                'updated_at'      => now(),
            ]);
        }
    }

    private function loadScheme(int $id): ?array
    {
        $s = $this->db()->table('fund_schemes')->where('id', $id)->whereNull('deleted_at')->first();
        if (!$s) return null;

        $funds = $this->db()->table('funds')->where('scheme_id', $id)->orderBy('sort_order')->get();

        return [
            'id'              => $s->id,
            'name'            => $s->name,
            'note'            => $s->note,
            'week_start_dow'  => (int) $s->week_start_dow,
            'start_date'      => $s->start_date,
            'income_flow_ids' => json_decode($s->income_flow_ids ?? '[]', true) ?: [],
            'is_active'       => (bool) $s->is_active,
            'funds'           => $funds->map(fn($f) => [
                'id'              => $f->id,
                'name'            => $f->name,
                'percent'         => (float) $f->percent,
                'flow_info_ids'   => json_decode($f->flow_info_ids ?? '[]', true) ?: [],
                'opening_balance' => (float) $f->opening_balance,
            ])->values(),
        ];
    }
}
