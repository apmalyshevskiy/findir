<?php

namespace App\Providers;

use App\Models\PersonalAccessToken;
use App\Models\TenantUser;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\ServiceProvider;
use Laravel\Sanctum\Sanctum;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(
            \Stancl\Tenancy\Contracts\TenantWithDatabase::class,
            \App\Models\Tenant::class
        );
    }

    public function boot(): void
    {
        Sanctum::usePersonalAccessTokenModel(PersonalAccessToken::class);

        // Кастомный резолвер пользователя по токену
        Sanctum::authenticateAccessTokensUsing(
            function ($accessToken, bool $isValid) {
                if (!$isValid) return false;

                // tokenable_type = "tenant:{tenant_id}:user"
                $parts    = explode(':', $accessToken->tokenable_type);
                $tenantId = $parts[1] ?? null;

                if (!$tenantId) return false;

                $dbName = 'findir_' . str_replace('-', '_', $tenantId);

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

                $userData = DB::connection($dbName)
                    ->table('users')
                    ->where('id', $accessToken->tokenable_id)
                    ->first();

                if (!$userData) return false;

                $user            = new TenantUser((array) $userData);
                $user->id        = $userData->id;
                $user->tenant_id = $tenantId;
                $user->setConnection($dbName);
                $user->exists    = true;

                // Привязываем токен к пользователю
                $user->withAccessToken($accessToken);

                return $user;
            }
        );
    }
}
