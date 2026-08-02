<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Шаблоны операций — сохранённые проводки для повторения в следующем периоде.
 * Хранит только поля операции; дату при подстановке задаёт пользователь.
 */
class OperationTemplatesController extends TenantController
{
    /** Поля операции, которые имеет смысл сохранять в шаблоне (без даты и сумм-однодневок). */
    private const FIELDS = [
        'project_id', 'amount', 'quantity',
        'in_bi_id', 'out_bi_id',
        'in_info_1_id', 'in_info_2_id', 'in_info_3_id',
        'out_info_1_id', 'out_info_2_id', 'out_info_3_id',
        'content', 'note',
    ];

    private function db()
    {
        return DB::connection($this->dbName);
    }

    // GET /operation-templates
    public function index(Request $request)
    {
        $this->initTenant($request);

        $rows = $this->db()->table('operation_templates')
            ->whereNull('deleted_at')
            ->orderByDesc('use_count')->orderByDesc('last_used_at')->orderBy('id')
            ->get();

        return response()->json(['data' => $rows->map(fn($r) => [
            'id'           => $r->id,
            'name'         => $r->name,
            'payload'      => json_decode($r->payload, true) ?: [],
            'use_count'    => (int) $r->use_count,
            'last_used_at' => $r->last_used_at,
        ])->values()]);
    }

    // POST /operation-templates
    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'    => 'required|string|max:100',
            'payload' => 'required|array',
        ]);

        $payload = array_intersect_key($data['payload'], array_flip(self::FIELDS));

        $id = $this->db()->table('operation_templates')->insertGetId([
            'name'       => $data['name'],
            'payload'    => json_encode($payload, JSON_UNESCAPED_UNICODE),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return response()->json(['data' => ['id' => $id, 'name' => $data['name'], 'payload' => $payload]], 201);
    }

    // POST /operation-templates/{id}/use — отметить применение (для сортировки по частоте)
    public function use(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->db()->table('operation_templates')->where('id', $id)->update([
            'use_count'    => DB::raw('use_count + 1'),
            'last_used_at' => now(),
            'updated_at'   => now(),
        ]);

        return response()->json(['ok' => true]);
    }

    // DELETE /operation-templates/{id}
    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->db()->table('operation_templates')->where('id', $id)
            ->update(['deleted_at' => now(), 'updated_at' => now()]);

        return response()->json(['ok' => true]);
    }
}
