<?php

namespace App\Http\Middleware;

use App\Services\Access;
use App\Services\AccountScope;
use App\Services\TenantService;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Проверка прав на каждый запрос к API.
 *
 * Прятать кнопки недостаточно: запрос уходит по адресу, а не по кнопке, и
 * человек с токеном «только просмотр» мог бы отправить его руками. Поэтому
 * решение принимается здесь, до контроллера, и одинаково для всех ста с лишним
 * маршрутов — по разделу и уровню, а не списком исключений.
 */
class EnsurePermission
{
    public function handle(Request $request, Closure $next)
    {
        $path = $request->path();

        // Вход, регистрация и здоровье живут до всяких прав
        if (Access::isPublic($path)) {
            return $next($request);
        }

        $token = $request->bearerToken();
        if (!$token) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $row = DB::table('personal_access_tokens')
            ->where('token', hash('sha256', $token))
            ->first();

        if (!$row) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $tenantId = TenantService::tenantIdFromRequest($request);
        $db       = TenantService::connect($tenantId);

        $user = DB::connection($db)->table('users')->where('id', $row->tokenable_id)->first();

        // Выключенный пользователь теряет доступ немедленно, не дожидаясь, пока
        // протухнет выданный ему токен
        if (!$user || !$user->is_active) {
            return response()->json(['message' => 'Доступ отключён администратором'], 403);
        }

        // Пользователь найден — кладём в запрос, чтобы контроллеры не искали
        // его по токену второй раз
        $request->attributes->set('findir_user_id', (int) $row->tokenable_id);

        $section = Access::sectionFor($path);
        $level   = Access::levelFor($request->method(), $path);

        // Архивная копия — дамп базы целиком, он обходит любые фильтры по
        // счетам. Кому закрыт хоть один счёт, тому закрыта и выгрузка, каким бы
        // ни был уровень в матрице разделов
        if ($section === 'backup' && !AccountScope::for($db, (int) $row->tokenable_id)->isEmpty()) {
            return response()->json([
                'message' => 'Архивная копия недоступна: в вашей должности есть закрытые счета, '
                    . 'а копия выгружает базу целиком.',
            ], 403);
        }

        // Маршрут вне карты разделов — значит новый и ещё не описан. Пускаем
        // только администратора: тихо открыть его всем было бы опаснее
        $permissions = Access::permissionsFor($db, (int) $row->tokenable_id);

        if ($section === null) {
            $isAdmin = DB::connection($db)->table('roles')
                ->where('id', $user->role_id)->where('code', 'admin')->exists();

            return $isAdmin ? $next($request) : $this->deny('этот раздел', $level);
        }

        if (!Access::allows($permissions[$section] ?? Access::NONE, $level)) {
            return $this->deny(Access::sections()[$section] ?? $section, $level);
        }

        return $next($request);
    }

    private function deny(string $section, string $level)
    {
        $levelName = mb_strtolower(Access::levels()[$level] ?? $level);

        return response()->json([
            'message' => "Недостаточно прав: раздел «{$section}», нужен уровень «{$levelName}». "
                . 'Обратитесь к администратору компании.',
        ], 403);
    }
}
