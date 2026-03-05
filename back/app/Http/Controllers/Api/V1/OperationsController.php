<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Operation;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class OperationsController extends TenantController
{
    private function model(): Operation
    {
        return (new Operation)->setConnection($this->dbName);
    }

    public function index(Request $request)
    {
        $this->initTenant($request);

        $query = $this->model()->newQuery()
            ->with([
                'inBalanceItem',
                'outBalanceItem',
                'inInfo1',
                'inInfo2',
                'outInfo1',
                'outInfo2',
            ])
            ->orderByDesc('date')
            ->orderByDesc('id');

        if ($request->project_id) $query->where('project_id', $request->project_id);
        if ($request->date_from)  $query->where('date', '>=', $request->date_from);
        if ($request->date_to)    $query->where('date', '<=', $request->date_to . ' 23:59:59');
        if ($request->in_bi_id)   $query->where('in_bi_id', $request->in_bi_id);
        if ($request->out_bi_id)  $query->where('out_bi_id', $request->out_bi_id);
        // Фильтр по конкретному элементу аналитики 
        if ($request->info_id) {
            $infoId = $request->info_id;
            $query->where(function($q) use ($infoId) {
           $q->where('in_info_1_id', $infoId)
                 ->orWhere('in_info_2_id', $infoId)
                ->orWhere('in_info_3_id', $infoId)
                ->orWhere('out_info_1_id', $infoId)
                 ->orWhere('out_info_2_id', $infoId)
                 ->orWhere('out_info_3_id', $infoId);
         });
}

        $perPage = $request->per_page ?? 50;
        $page    = $request->page ?? 1;
        $total   = $query->count();
        $items   = $query->offset(($page - 1) * $perPage)->limit($perPage)->get();

        // Форматируем для фронтенда
        $data = $items->map(fn($op) => $this->formatOperation($op));

        return response()->json(['data' => $data, 'total' => $total, 'page' => (int)$page]);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'date'          => 'required|date',
            'project_id'    => 'required|integer',
            'amount'        => 'required|numeric',
            'quantity'      => 'nullable|numeric',
            'in_bi_id'      => 'required|integer',
            'out_bi_id'     => 'required|integer',
            'in_info_1_id'  => 'nullable|integer',
            'in_info_2_id'  => 'nullable|integer',
            'in_info_3_id'  => 'nullable|integer',
            'out_info_1_id' => 'nullable|integer',
            'out_info_2_id' => 'nullable|integer',
            'out_info_3_id' => 'nullable|integer',
            'note'          => 'nullable|string|max:1000',
        ]);

        $op = $this->model()->newQuery()->create(array_merge($data, [
            'quantity' => $data['quantity'] ?? 0,
            'source'   => 'manual',
        ]));

        $op->load(['inBalanceItem', 'outBalanceItem', 'inInfo1', 'inInfo2', 'outInfo1', 'outInfo2']);

        return response()->json(['data' => $this->formatOperation($op)], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'date'          => 'required|date',
            'project_id'    => 'required|integer',
            'amount'        => 'required|numeric',
            'quantity'      => 'nullable|numeric',
            'in_bi_id'      => 'required|integer',
            'out_bi_id'     => 'required|integer',
            'in_info_1_id'  => 'nullable|integer',
            'in_info_2_id'  => 'nullable|integer',
            'in_info_3_id'  => 'nullable|integer',
            'out_info_1_id' => 'nullable|integer',
            'out_info_2_id' => 'nullable|integer',
            'out_info_3_id' => 'nullable|integer',
            'note'          => 'nullable|string|max:1000',
        ]);

        $op = $this->model()->newQuery()->findOrFail($id);
        $op->update(array_merge($data, ['quantity' => $data['quantity'] ?? 0]));
        $op->load(['inBalanceItem', 'outBalanceItem', 'inInfo1', 'inInfo2', 'outInfo1', 'outInfo2']);

        return response()->json(['data' => $this->formatOperation($op)]);
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->model()->newQuery()->findOrFail($id)->delete();

        return response()->json(['message' => 'Операция удалена']);
    }

    private function formatOperation(Operation $op): array
    {
        return [
            'id'              => $op->id,
            'date'            => $op->date,
            'amount'          => $op->amount,
            'quantity'        => $op->quantity,
            'note'            => $op->note,
            'source'          => $op->source,
            'project_id'      => $op->project_id,
            'in_bi_id'        => $op->in_bi_id,
            'in_bi_code'      => $op->inBalanceItem?->code,
            'in_bi_name'      => $op->inBalanceItem?->name,
            'in_info_1_type'  => $op->inBalanceItem?->info_1_type,
            'in_info_2_type'  => $op->inBalanceItem?->info_2_type,
            'out_bi_id'       => $op->out_bi_id,
            'out_bi_code'     => $op->outBalanceItem?->code,
            'out_bi_name'     => $op->outBalanceItem?->name,
            'out_info_1_type' => $op->outBalanceItem?->info_1_type,
            'out_info_2_type' => $op->outBalanceItem?->info_2_type,
            'in_info_1_id'    => $op->in_info_1_id,
            'in_info_1_name'  => $op->inInfo1?->name,
            'in_info_2_id'    => $op->in_info_2_id,
            'in_info_2_name'  => $op->inInfo2?->name,
            'out_info_1_id'   => $op->out_info_1_id,
            'out_info_1_name' => $op->outInfo1?->name,
            'out_info_2_id'   => $op->out_info_2_id,
            'out_info_2_name' => $op->outInfo2?->name,
            'created_at'      => $op->created_at,
        ];
    }
}
