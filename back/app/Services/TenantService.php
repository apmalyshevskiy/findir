<?php

namespace App\Services;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TenantService
{
    public static function dbName(string $tenantId): string
    {
        return 'findir_' . str_replace('-', '_', strtolower($tenantId));
    }

    public static function connect(string $tenantId): string
    {
        $dbName = self::dbName($tenantId);
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

    public static function tenantIdFromRequest(Request $request): string
    {
        $plainToken = $request->bearerToken();
        $tokenRow   = DB::table('personal_access_tokens')
            ->where('token', hash('sha256', $plainToken))
            ->first();

        if (!$tokenRow) abort(401);

        $abilities = json_decode($tokenRow->abilities, true);
        foreach ($abilities as $ability) {
            if (str_starts_with($ability, 'tenant:')) {
                return substr($ability, 7);
            }
        }
        abort(401);
    }
}
