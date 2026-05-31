<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\PaymentClassificationRule;
use Illuminate\Http\Request;

class PaymentClassificationRuleController extends TenantController
{
    private function model(): PaymentClassificationRule
    {
        return (new PaymentClassificationRule)->setConnection($this->dbName);
    }

    public function index(Request $request)
    {
        $this->initTenant($request);

        // Порядок применения матчером: priority DESC, затем id —
        // показываем правила в том же порядке, в каком они проверяются.
        $rules = $this->model()->newQuery()
            ->orderByDesc('priority')
            ->orderBy('id')
            ->get();

        return response()->json(['data' => $rules]);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $this->validatePayload($request);

        $rule = $this->model()->newQuery()->create([
            'direction'        => $data['direction'] ?? 'any',
            'inn'              => $data['inn'] ?? null,
            'purpose_keywords' => $data['purpose_keywords'] ?? null,
            'has_kbk'          => $data['has_kbk'] ?? null,
            'amount_min'       => $data['amount_min'] ?? null,
            'amount_max'       => $data['amount_max'] ?? null,
            'category'         => $data['category'],
            'priority'         => $data['priority'] ?? 50,
            'source'           => $data['source'] ?? 'manual',
            'is_active'        => $data['is_active'] ?? true,
        ]);

        return response()->json(['data' => $rule], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $this->validatePayload($request);

        $rule = $this->model()->newQuery()->findOrFail($id);
        $rule->update($data);

        return response()->json(['data' => $rule]);
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->model()->newQuery()->findOrFail($id)->delete();

        return response()->json(['message' => 'Удалено']);
    }

    private function validatePayload(Request $request): array
    {
        return $request->validate([
            'direction'        => 'nullable|string|in:in,out,any',
            'inn'              => 'nullable|string|max:20',
            'purpose_keywords' => 'nullable|string',
            'has_kbk'          => 'nullable|boolean',
            'amount_min'       => 'nullable|numeric',
            'amount_max'       => 'nullable|numeric',
            'category'         => 'required|string|max:32',
            'priority'         => 'nullable|integer',
            'source'           => 'nullable|string|in:manual,learned',
            'is_active'        => 'nullable|boolean',
        ]);
    }
}
