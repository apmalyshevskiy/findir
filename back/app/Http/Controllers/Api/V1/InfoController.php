<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Info;
use App\Services\History\History;
use App\Services\History\HistoryPresenter;
use App\Services\History\HistoryRestorer;
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
            ->orderBy('sort_order');

        if ($request->type) {
            $query->ofType($request->type);
        }

        return response()->json(['data' => $query->get()]);
    }

    /** GET /info/{id}/history — кто и когда правил элемент справочника */
    public function history(Request $request, int $id)
    {
        $this->initTenant($request);

        return response()->json([
            'data' => (new HistoryPresenter($this->dbName))->forObject('info', $id),
        ]);
    }

    /**
     * POST /info/{id}/restore/{version} — вернуть элемент к версии.
     *
     * Удалённый при этом оживает: если человек возвращает версию, он хочет
     * элемент обратно. Смена вида справочника задним числом не пройдёт, пока
     * на элемент ссылаются операции.
     */
    public function restore(Request $request, int $id, int $version)
    {
        $this->initTenant($request);
        app(History::class)->source('manual');

        $res = (new HistoryRestorer($this->dbName, $this->scope, $this->editLockDate()))
            ->restore('info', $id, $version);

        return response()->json($res, $res['ok'] ? 200 : 422);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'        => 'required|string|max:255',
            'type'        => 'required|string',
            'code'        => 'nullable|string|max:35',
            'description' => 'nullable|string',
            'inn'         => 'nullable|string|max:12',
            'parent_id'   => 'nullable|integer',
            'sort_order'  => 'nullable|integer',
            'is_variable' => 'nullable|boolean',
            'default_expense_id' => 'nullable|integer',
        ]);

        $info = $this->model()->newQuery()->create([
            'name'        => $data['name'],
            'type'        => $data['type'],
            'code'        => $data['code'] ?? null,
            'description' => $data['description'] ?? null,
            'inn'         => $data['inn'] ?? null,
            'parent_id'   => $data['parent_id'] ?? null,
            'sort_order'  => $data['sort_order'] ?? 0,
            'is_active'   => true,
            'is_variable' => $data['is_variable'] ?? false,
            'default_expense_id' => $data['default_expense_id'] ?? null,
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
            'inn'         => 'nullable|string|max:12',
            'parent_id'   => 'nullable|integer',
            'sort_order'  => 'nullable|integer',
            'is_active'   => 'nullable|boolean',
            'is_variable' => 'nullable|boolean',
            'default_expense_id' => 'nullable|integer',
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
