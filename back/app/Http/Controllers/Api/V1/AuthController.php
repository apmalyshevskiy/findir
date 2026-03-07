<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Tenant;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    private function connectTenant(string $tenantId): string
    {
        $dbName = 'findir_' . str_replace('-', '_', strtolower($tenantId));
        config(["database.connections.{$dbName}" => [
            'driver'    => 'mysql',
            'host'      => env('DB_HOST', 'mysql'),
            'port'      => env('DB_PORT', '3306'),
            'database'  => $dbName,
            'username'  => env('DB_USERNAME', 'findir'),
            'password'  => env('DB_PASSWORD', 'secret'),
            'charset'   => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
            'prefix'    => '',
            'strict'    => true,
        ]]);
        return $dbName;
    }

    private function createToken(string $tenantId, int $userId): string
    {
        $plainToken = Str::random(64);
        DB::table('personal_access_tokens')->insert([
            'tokenable_type' => 'tenant_user',
            'tokenable_id'   => $userId,
            'name'           => 'auth_token',
            'token'          => hash('sha256', $plainToken),
            'abilities'      => json_encode(['*', 'tenant:' . $tenantId]),
            'created_at'     => now(),
            'updated_at'     => now(),
        ]);
        return $plainToken;
    }

    /**
     * Сгенерировать уникальный slug по названию компании.
     * Если slug занят — добавляет цифру: ooo-romashka → ooo-romashka-2 → ooo-romashka-3
     */
    private function generateUniqueSlug(string $companyName): string
    {
        $base = Str::slug($companyName);
        if (!$base) $base = 'company';

        $slug = $base;
        $i    = 2;
        while (DB::table('tenants')->where('id', $slug)->exists()) {
            $slug = $base . '-' . $i;
            $i++;
        }
        return $slug;
    }

    /**
     * Проверить уникальность домена (для live-валидации на фронте)
     * GET /api/v1/check-domain?domain=ooo-romashka
     */
    public function checkDomain(Request $request)
    {
        $domain = Str::slug($request->query('domain', ''));

        if (!$domain) {
            return response()->json(['available' => false, 'error' => 'Домен не может быть пустым']);
        }

        if (strlen($domain) < 3) {
            return response()->json(['available' => false, 'error' => 'Минимум 3 символа']);
        }

        $exists = DB::table('tenants')->where('id', $domain)->exists();

        return response()->json([
            'available' => !$exists,
            'domain'    => $domain,
            'full'      => $domain . '.' . env('APP_BASE_DOMAIN', 'localhost'),
        ]);
    }

    /**
     * Предложить slug по названию компании (без регистрации)
     * GET /api/v1/suggest-domain?company_name=ООО Ромашка
     */
    public function suggestDomain(Request $request)
    {
        $companyName = $request->query('company_name', '');
        $slug        = $this->generateUniqueSlug($companyName);

        return response()->json([
            'domain' => $slug,
            'full'   => $slug . '.' . env('APP_BASE_DOMAIN', 'localhost'),
        ]);
    }

    public function register(Request $request)
    {
        $data = $request->validate([
            'company_name' => 'required|string|max:255',
            'domain'       => 'required|string|max:63|regex:/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/',
            'name'         => 'required|string|max:255',
            'email'        => 'required|email|max:255',
            'password'     => 'required|string|min:8|confirmed',
        ], [
            'domain.regex' => 'Домен может содержать только строчные латинские буквы, цифры и дефис',
        ]);

        // Финальная проверка уникальности домена
        if (DB::table('tenants')->where('id', $data['domain'])->exists()) {
            throw ValidationException::withMessages([
                'domain' => ['Этот домен уже занят. Пожалуйста, выберите другой.'],
            ]);
        }

        $tenantId = $data['domain'];
        $dbName   = $this->connectTenant($tenantId);

        $tenant = Tenant::create([
            'id'            => $tenantId,
            'name'          => $data['company_name'],
            'plan'          => 'trial',
            'status'        => 'trial',
            'trial_ends_at' => now()->addDays(14),
        ]);

        // Домен 3-го уровня: ooo-romashka.findir.ru
        $baseDomain = env('APP_BASE_DOMAIN', 'localhost');
        $tenant->domains()->create(['domain' => $tenantId . '.' . $baseDomain]);

        DB::statement("CREATE DATABASE IF NOT EXISTS `{$dbName}`");

        Artisan::call('migrate', [
            '--database' => $dbName,
            '--path'     => 'database/migrations/tenant',
            '--force'    => true,
        ]);

        DB::setDefaultConnection($dbName);
        (new \Database\Seeders\TenantDatabaseSeeder())->setContainer(app())->run();
        DB::setDefaultConnection('mysql');

        $userId = DB::connection($dbName)->table('users')->insertGetId([
            'name'       => $data['name'],
            'email'      => $data['email'],
            'password'   => Hash::make($data['password']),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $plainToken = $this->createToken($tenantId, $userId);

        return response()->json([
            'message' => 'Регистрация успешна',
            'token'   => $plainToken,
            'user'    => [
                'id'        => $userId,
                'name'      => $data['name'],
                'email'     => $data['email'],
                'tenant_id' => $tenantId,
            ],
            'tenant' => [
                'id'            => $tenant->id,
                'name'          => $tenant->name,
                'plan'          => $tenant->plan,
                'trial_ends_at' => $tenant->trial_ends_at,
                'domain'        => $tenantId . '.' . $baseDomain,
            ],
        ], 201);
    }

    public function login(Request $request)
    {
        $data = $request->validate([
            'email'     => 'required|email',
            'password'  => 'required|string',
            'tenant_id' => 'required|string|exists:tenants,id',
        ]);

        $tenant = Tenant::findOrFail($data['tenant_id']);
        $dbName = $this->connectTenant($tenant->id);

        $user = DB::connection($dbName)->table('users')
            ->where('email', $data['email'])
            ->first();

        if (!$user || !Hash::check($data['password'], $user->password)) {
            throw ValidationException::withMessages([
                'email' => ['Неверный email или пароль.'],
            ]);
        }

        DB::table('personal_access_tokens')
            ->where('tokenable_type', 'tenant_user')
            ->where('tokenable_id', $user->id)
            ->delete();

        $plainToken = $this->createToken($tenant->id, $user->id);

        return response()->json([
            'token'  => $plainToken,
            'user'   => [
                'id'        => $user->id,
                'name'      => $user->name,
                'email'     => $user->email,
                'tenant_id' => $tenant->id,
            ],
            'tenant' => [
                'id'   => $tenant->id,
                'name' => $tenant->name,
                'plan' => $tenant->plan,
            ],
        ]);
    }

    public function me(Request $request)
    {
        $plainToken = $request->bearerToken();
        if (!$plainToken) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $tokenRow = DB::table('personal_access_tokens')
            ->where('token', hash('sha256', $plainToken))
            ->first();

        if (!$tokenRow) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $abilities = json_decode($tokenRow->abilities, true);
        $tenantId  = null;
        foreach ($abilities as $ability) {
            if (str_starts_with($ability, 'tenant:')) {
                $tenantId = substr($ability, 7);
                break;
            }
        }

        if (!$tenantId) {
            return response()->json(['message' => 'Unauthorized'], 401);
        }

        $dbName = $this->connectTenant($tenantId);
        $user   = DB::connection($dbName)->table('users')
            ->where('id', $tokenRow->tokenable_id)
            ->first();

        return response()->json([
            'user' => [
                'id'        => $user->id,
                'name'      => $user->name,
                'email'     => $user->email,
                'tenant_id' => $tenantId,
            ],
        ]);
    }

    public function logout(Request $request)
    {
        $plainToken = $request->bearerToken();
        if ($plainToken) {
            DB::table('personal_access_tokens')
                ->where('token', hash('sha256', $plainToken))
                ->delete();
        }
        return response()->json(['message' => 'Выход выполнен']);
    }
}
