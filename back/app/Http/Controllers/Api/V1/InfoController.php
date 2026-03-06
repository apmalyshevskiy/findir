<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Info;
use Illuminate\Http\Request;

class InfoController extends TenantController
{
    private function model(): Info
    {
        return (new Info)->setConnection($this->dbName);
    }

    public function index(Request $request)
    {
        $this->initTenant($request);

        $query = $this->model()->newQuery()->active()
            ->orderBy('type')
         //   ->orderByRaw('COALESCE(parent_id, 0)')
            ->orderBy('sort_order');
            //->orderBy('name');

        if ($request->type) {
            $query->ofType($request->type);
        }

        return response()->json(['data' => $query->get()]);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'        => 'required|string|max:255',
            'type'        => 'required|string',
            'code'        => 'nullable|string|max:35',
            'description' => 'nullable|string',
            'parent_id'   => 'nullable|integer',
            'sort_order'  => 'nullable|integer',
        ]);

        $info = $this->model()->newQuery()->create([
            'name'        => $data['name'],
            'type'        => $data['type'],
            'code'        => $data['code'] ?? null,
            'description' => $data['description'] ?? null,
            'parent_id'   => $data['parent_id'] ?? null,
            'sort_order'  => $data['sort_order'] ?? 0,
            'is_active'   => true,
        ]);

        return response()->json(['data' => $info], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'        => 'required|string|max:255',
            'type'        => 'required|string',
            'code'        => 'nullable|string|max:35',
            'description' => 'nullable|string',
            'parent_id'   => 'nullable|integer',
            'sort_order'  => 'nullable|integer',
            'is_active'   => 'nullable|boolean',
        ]);

        $info = $this->model()->newQuery()->findOrFail($id);
        $info->update($data);

        return response()->json(['data' => $info]);
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->model()->newQuery()->findOrFail($id)->delete();

        return response()->json(['message' => 'Удалено']);
    }
}
