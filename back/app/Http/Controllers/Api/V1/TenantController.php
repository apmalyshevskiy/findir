<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Services\TenantService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

abstract class TenantController extends Controller
{
    /** Ключ в таблице settings: дата запрета редактирования (закрытый период). */
    protected const EDIT_LOCK_KEY = 'edit_lock_date';

    protected string $tenantId;
    protected string $dbName;

    protected function initTenant(Request $request): void
    {
        $this->tenantId = TenantService::tenantIdFromRequest($request);
        $this->dbName   = TenantService::connect($this->tenantId);
    }

    /** ID текущего пользователя из Bearer-токена (или null). */
    protected function currentUserId(Request $request): ?int
    {
        $plain = $request->bearerToken();
        if (!$plain) return null;

        $id = DB::table('personal_access_tokens')
            ->where('token', hash('sha256', $plain))
            ->value('tokenable_id');

        return $id ? (int) $id : null;
    }

    /** Дата запрета редактирования ('Y-m-d') или null, если запрет не установлен. */
    protected function editLockDate(): ?string
    {
        $value = DB::connection($this->dbName)
            ->table('settings')
            ->where('key', self::EDIT_LOCK_KEY)
            ->value('value');

        return $value ?: null;
    }

    /**
     * Проверка даты на попадание в закрытый период.
     * Возвращает 422-ответ, если дата <= даты запрета (включительно), иначе null.
     */
    protected function lockError($date): ?JsonResponse
    {
        if (!$date) return null;

        $lock = $this->editLockDate();
        if (!$lock) return null;

        if (Carbon::parse($date)->toDateString() <= $lock) {
            return response()->json([
                'message'         => "Период закрыт для редактирования по $lock включительно.",
                'edit_lock_date'  => $lock,
            ], 422);
        }

        return null;
    }
}
