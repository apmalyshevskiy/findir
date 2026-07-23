<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ProjectsController extends TenantController
{
    public function index(Request $request)
    {
        $this->initTenant($request);

        $projects = DB::connection($this->dbName)
            ->table('projects')
            ->whereNull('deleted_at')
            ->orderBy('name')
            ->select('id', 'parent_id', 'name', 'currency', 'timezone')
            ->get();

        return response()->json(['data' => $projects]);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $this->validated($request);

        $id = DB::connection($this->dbName)->table('projects')->insertGetId([
            'parent_id'  => $data['parent_id'] ?? null,
            'name'       => $data['name'],
            'currency'   => $data['currency'] ?? 'RUB',
            'timezone'   => $data['timezone'] ?? 'Europe/Moscow',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return response()->json(['data' => $this->find($id)], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $project = $this->find($id);
        if (!$project) {
            return response()->json(['message' => 'Проект не найден'], 404);
        }

        $data = $this->validated($request);

        DB::connection($this->dbName)->table('projects')->where('id', $id)->update([
            'parent_id'  => $data['parent_id'] ?? null,
            'name'       => $data['name'],
            'currency'   => $data['currency'] ?? $project->currency,
            'timezone'   => $data['timezone'] ?? $project->timezone,
            'updated_at' => now(),
        ]);

        return response()->json(['data' => $this->find($id)]);
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $project = $this->find($id);
        if (!$project) {
            return response()->json(['message' => 'Проект не найден'], 404);
        }

        // Нельзя удалить проект, если по нему есть операции — иначе они осиротеют.
        $opCount = DB::connection($this->dbName)->table('operations')
            ->where('project_id', $id)
            ->whereNull('deleted_at')
            ->count();
        if ($opCount > 0) {
            return response()->json([
                'message' => "По проекту есть операции ($opCount). Удаление невозможно.",
            ], 422);
        }

        // Нельзя удалить проект, у которого есть дочерние проекты.
        $childCount = DB::connection($this->dbName)->table('projects')
            ->where('parent_id', $id)
            ->whereNull('deleted_at')
            ->count();
        if ($childCount > 0) {
            return response()->json([
                'message' => "У проекта есть вложенные проекты ($childCount). Удаление невозможно.",
            ], 422);
        }

        DB::connection($this->dbName)->table('projects')->where('id', $id)->update([
            'deleted_at' => now(),
        ]);

        return response()->json(['message' => 'Проект удалён']);
    }

    /** Валидация полей проекта. */
    private function validated(Request $request): array
    {
        return $request->validate([
            'name'      => 'required|string|max:255',
            'currency'  => 'nullable|string|size:3',
            'timezone'  => 'nullable|string|max:50',
            'parent_id' => 'nullable|integer',
        ]);
    }

    private function find(int $id)
    {
        return DB::connection($this->dbName)
            ->table('projects')
            ->whereNull('deleted_at')
            ->where('id', $id)
            ->select('id', 'parent_id', 'name', 'currency', 'timezone')
            ->first();
    }
}
