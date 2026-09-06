<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Access;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * Сотрудники компании и их должности.
 *
 * Пароль задаёт администратор и передаёт человеку — почта не настроена, и
 * приглашение письмом сейчас никуда бы не ушло. Свой пароль сотрудник меняет
 * сам в профиле.
 *
 * Уволенных не удаляем, а выключаем: их операции остаются в учёте, и автор
 * должен читаться. Удаление оставлено на случай ошибочно заведённой учётки.
 */
class UsersController extends TenantController
{
    public function index(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $users = DB::connection($this->dbName)->table('users as u')
            ->leftJoin('roles as r', 'r.id', '=', 'u.role_id')
            ->orderBy('u.id')
            ->get(['u.id', 'u.name', 'u.email', 'u.role_id', 'u.is_active', 'u.last_login_at',
                   'r.name as role_name', 'r.code as role_code']);

        return response()->json([
            'data' => $users,
            'me'   => $this->currentUserId($request),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'     => 'required|string|max:255',
            'email'    => 'required|email|max:255',
            'password' => 'required|string|min:8',
            'role_id'  => 'required|integer',
        ]);

        if ($this->emailTaken($data['email'])) {
            return response()->json(['message' => 'Сотрудник с такой почтой уже заведён'], 422);
        }

        if (!$this->roleExists($data['role_id'])) {
            return response()->json(['message' => 'Должность не найдена'], 422);
        }

        $id = DB::connection($this->dbName)->table('users')->insertGetId([
            'name'       => trim($data['name']),
            'email'      => mb_strtolower(trim($data['email'])),
            'password'   => Hash::make($data['password']),
            'role_id'    => $data['role_id'],
            'is_active'  => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return response()->json(['data' => ['id' => $id], 'message' => 'Сотрудник заведён'], 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'      => 'sometimes|string|max:255',
            'email'     => 'sometimes|email|max:255',
            'role_id'   => 'sometimes|integer',
            'is_active' => 'sometimes|boolean',
        ]);

        $user = DB::connection($this->dbName)->table('users')->where('id', $id)->first();
        if (!$user) return response()->json(['message' => 'Сотрудник не найден'], 404);

        if (isset($data['email']) && $this->emailTaken($data['email'], $id)) {
            return response()->json(['message' => 'Такая почта уже занята'], 422);
        }
        if (isset($data['role_id']) && !$this->roleExists($data['role_id'])) {
            return response()->json(['message' => 'Должность не найдена'], 422);
        }

        // Компания без администратора становится неуправляемой: настройки,
        // должности и пользователи закрыты для всех, включая владельца
        $losesAdmin = (isset($data['role_id']) && !$this->isAdminRole($data['role_id']))
            || (isset($data['is_active']) && !$data['is_active']);

        if ($losesAdmin && $this->isLastAdmin($id)) {
            return response()->json([
                'message' => 'Это последний администратор — сначала назначьте другого',
            ], 422);
        }

        $update = array_intersect_key($data, array_flip(['name', 'email', 'role_id', 'is_active']));
        if (isset($update['email'])) $update['email'] = mb_strtolower(trim($update['email']));
        $update['updated_at'] = now();

        DB::connection($this->dbName)->table('users')->where('id', $id)->update($update);

        // Выключенному сотруднику гасим и действующие сессии: иначе он
        // продолжил бы работать по выданному токену до самого выхода
        if (isset($data['is_active']) && !$data['is_active']) {
            $this->revokeTokens($id);
        }

        return response()->json(['message' => 'Сохранено']);
    }

    /** Администратор задаёт новый пароль сотруднику */
    public function password(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate(['password' => 'required|string|min:8']);

        $exists = DB::connection($this->dbName)->table('users')->where('id', $id)->exists();
        if (!$exists) return response()->json(['message' => 'Сотрудник не найден'], 404);

        DB::connection($this->dbName)->table('users')->where('id', $id)->update([
            'password'   => Hash::make($data['password']),
            'updated_at' => now(),
        ]);

        // Смена пароля выбрасывает старые сессии — иначе прежний доступ
        // сохранился бы у того, у кого пароль и меняли
        $this->revokeTokens($id, $this->currentUserId($request) === $id ? $request->bearerToken() : null);

        return response()->json(['message' => 'Пароль изменён']);
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        if ($this->currentUserId($request) === $id) {
            return response()->json(['message' => 'Нельзя удалить самого себя'], 422);
        }
        if ($this->isLastAdmin($id)) {
            return response()->json(['message' => 'Это последний администратор — сначала назначьте другого'], 422);
        }

        $ops = DB::connection($this->dbName)->table('documents')->where('created_by', $id)->count();
        if ($ops > 0) {
            return response()->json([
                'message' => "Сотрудник значится автором документов ({$ops}) — его можно выключить, но не удалить",
            ], 422);
        }

        DB::connection($this->dbName)->table('users')->where('id', $id)->delete();
        $this->revokeTokens($id);

        return response()->json(['message' => 'Сотрудник удалён']);
    }

    // ── Вспомогательное ───────────────────────────────────────────────────────

    private function emailTaken(string $email, ?int $exceptId = null): bool
    {
        return DB::connection($this->dbName)->table('users')
            ->where('email', mb_strtolower(trim($email)))
            ->when($exceptId, fn($q) => $q->where('id', '!=', $exceptId))
            ->exists();
    }

    private function roleExists(int $roleId): bool
    {
        return DB::connection($this->dbName)->table('roles')->where('id', $roleId)->exists();
    }

    private function isAdminRole(int $roleId): bool
    {
        return DB::connection($this->dbName)->table('roles')
            ->where('id', $roleId)->where('code', 'admin')->exists();
    }

    /** Этот пользователь — единственный действующий администратор? */
    private function isLastAdmin(int $userId): bool
    {
        $adminId = DB::connection($this->dbName)->table('roles')->where('code', 'admin')->value('id');
        if (!$adminId) return false;

        $user = DB::connection($this->dbName)->table('users')->where('id', $userId)->first();
        if (!$user || (int) $user->role_id !== (int) $adminId || !$user->is_active) return false;

        $others = DB::connection($this->dbName)->table('users')
            ->where('role_id', $adminId)->where('is_active', true)
            ->where('id', '!=', $userId)->count();

        return $others === 0;
    }

    /** Погасить сессии сотрудника, кроме текущей (если меняем пароль себе) */
    private function revokeTokens(int $userId, ?string $keepPlainToken = null): void
    {
        $query = DB::table('personal_access_tokens')
            ->where('tokenable_type', 'tenant_user')
            ->where('tokenable_id', $userId)
            ->where('tenant_id', $this->tenantId);

        if ($keepPlainToken) {
            $query->where('token', '!=', hash('sha256', $keepPlainToken));
        }

        $query->delete();
    }
}
