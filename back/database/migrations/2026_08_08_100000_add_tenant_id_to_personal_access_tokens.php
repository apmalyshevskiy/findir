<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Явная привязка токена к компании.
 *
 * Раньше компанию можно было узнать только разобрав JSON в abilities, а
 * tokenable_id — это id пользователя ВНУТРИ своей базы, и у владельца каждой
 * компании он равен 1. Из-за этого выход/вход в одну компанию задевал токены
 * одноимённых пользователей во всех остальных.
 *
 * abilities оставляем как есть: на них завязана проверка доступа.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->string('tenant_id')->nullable()->after('tokenable_id')->index();
        });

        // Заполняем по уже выданным токенам, иначе действующие сессии
        // оказались бы «ничьими» и первый же вход их бы не нашёл
        foreach (DB::table('personal_access_tokens')->select('id', 'abilities')->get() as $row) {
            foreach ((array) json_decode($row->abilities ?? '[]', true) as $ability) {
                if (is_string($ability) && str_starts_with($ability, 'tenant:')) {
                    DB::table('personal_access_tokens')
                        ->where('id', $row->id)
                        ->update(['tenant_id' => substr($ability, 7)]);
                    break;
                }
            }
        }
    }

    public function down(): void
    {
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->dropIndex(['tenant_id']);
            $table->dropColumn('tenant_id');
        });
    }
};
