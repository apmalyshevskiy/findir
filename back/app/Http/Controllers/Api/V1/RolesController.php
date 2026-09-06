<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Access;
use App\Services\AccountScope;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Должности — именованные наборы прав по разделам.
 *
 * Устроены как виды документов: две заводские заводятся миграцией, свои
 * («Кассир», «Бухгалтер») компания собирает сама. Код должности неизменяем:
 * на `admin` завязаны проверки «может ли этот человек управлять доступом».
 */
class RolesController extends TenantController
{
    public function index(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $counts = DB::connection($this->dbName)->table('users')
            ->selectRaw('role_id, count(*) c')->groupBy('role_id')->pluck('c', 'role_id');

        $roles = DB::connection($this->dbName)->table('roles')
            ->orderBy('sort_order')->orderBy('id')->get();

        return response()->json([
            'sections' => Access::sections(),
            'levels'   => Access::levels(),
            'data'     => $roles->map(fn($r) => [
                'id'              => $r->id,
                'code'            => $r->code,
                'name'            => $r->name,
                'permissions'     => json_decode((string) $r->permissions, true) ?: [],
                // Отмеченные счета, без раскрытия по иерархии: на экране должны
                // стоять ровно те галочки, что поставил человек
                'denied_accounts' => array_map('intval', json_decode((string) $r->denied_accounts, true) ?: []),
                'is_system'       => (bool) $r->is_system,
                'sort_order'      => $r->sort_order,
                'users_count'     => (int) ($counts[$r->id] ?? 0),
            ]),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $this->validated($request);

        $id = DB::connection($this->dbName)->table('roles')->insertGetId([
            'code'            => $this->makeCode($data['name']),
            'name'            => $data['name'],
            'permissions'     => json_encode($data['permissions']),
            'denied_accounts' => json_encode($data['denied_accounts']),
            'is_system'       => false,
            'sort_order'      => $data['sort_order'],
            'created_at'      => now(),
            'updated_at'      => now(),
        ]);

        return response()->json(['data' => ['id' => $id], 'message' => 'Должность заведена'], 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $role = DB::connection($this->dbName)->table('roles')->where('id', $id)->first();
        if (!$role) return response()->json(['message' => 'Должность не найдена'], 404);

        $data = $this->validated($request);

        // У администратора права не режем: иначе компанию можно закрыть от
        // самой себя — вместе с этой же страницей должностей. Счета туда же:
        // администратор, который чего-то не видит, не сможет это и починить
        $update = $role->code === 'admin'
            ? ['name' => $data['name'], 'sort_order' => $data['sort_order']]
            : ['name' => $data['name'], 'sort_order' => $data['sort_order'],
               'permissions'     => json_encode($data['permissions']),
               'denied_accounts' => json_encode($data['denied_accounts'])];

        $update['updated_at'] = now();

        DB::connection($this->dbName)->table('roles')->where('id', $id)->update($update);

        // Скоуп кэшируется на запрос, а этот же запрос мог его уже прочитать
        AccountScope::forgetCache();

        return response()->json([
            'message' => $role->code === 'admin'
                ? 'Название сохранено. Права администратора не ограничиваются.'
                : 'Должность сохранена',
        ]);
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $role = DB::connection($this->dbName)->table('roles')->where('id', $id)->first();
        if (!$role) return response()->json(['message' => 'Должность не найдена'], 404);

        if ($role->is_system) {
            return response()->json(['message' => 'Заводскую должность удалить нельзя'], 422);
        }

        $used = DB::connection($this->dbName)->table('users')->where('role_id', $id)->count();
        if ($used > 0) {
            return response()->json([
                'message' => "Должность занята сотрудниками ({$used}) — сначала переведите их на другую",
            ], 422);
        }

        DB::connection($this->dbName)->table('roles')->where('id', $id)->delete();

        return response()->json(['message' => 'Должность удалена']);
    }

    // ── Вспомогательное ───────────────────────────────────────────────────────

    private function validated(Request $request): array
    {
        $levels = implode(',', array_keys(Access::levels()));

        $data = $request->validate([
            'name'              => 'required|string|max:100',
            'permissions'       => 'required|array',
            'permissions.*'     => "string|in:{$levels}",
            'denied_accounts'   => 'nullable|array',
            'denied_accounts.*' => 'integer',
            'sort_order'        => 'nullable|integer',
        ]);

        // Неизвестные разделы отбрасываем, отсутствующие считаем закрытыми:
        // карта прав всегда полная, и новый раздел не открывается сам собой
        $permissions = [];
        foreach (array_keys(Access::sections()) as $section) {
            $permissions[$section] = $data['permissions'][$section] ?? Access::NONE;
        }

        // Несуществующие счета отбрасываем: удалили счёт — должность не должна
        // тащить за собой мёртвый id
        $denied = array_values(array_unique(array_map('intval', $data['denied_accounts'] ?? [])));
        if ($denied) {
            $denied = DB::connection($this->dbName)->table('balance_items')
                ->whereIn('id', $denied)->pluck('id')->map('intval')->values()->all();
        }

        return [
            'name'            => trim($data['name']),
            'permissions'     => $permissions,
            'denied_accounts' => $denied,
            'sort_order'      => $data['sort_order'] ?? 0,
        ];
    }

    private function makeCode(string $name): string
    {
        $base = Str::slug(Str::ascii($name)) ?: 'role';
        $code = $base;
        $i    = 2;

        while (DB::connection($this->dbName)->table('roles')->where('code', $code)->exists()) {
            $code = $base . '-' . $i++;
        }

        return $code;
    }
}
