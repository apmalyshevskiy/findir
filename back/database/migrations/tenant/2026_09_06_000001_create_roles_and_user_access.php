<?php

use App\Services\Access;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Должности и доступ пользователей.
 *
 * До сих пор доступ проверялся одним условием — есть ли токен, — и любой
 * вошедший мог всё. Теперь у пользователя есть должность, а у должности —
 * набор прав по разделам.
 *
 * Существующему владельцу каждой базы выдаём администратора: он и так мог всё,
 * и потерять доступ к собственной компании из-за миграции было бы дико.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('roles', function (Blueprint $table) {
            $table->id();
            // Код неизменяем: на него смотрят проверки «это администратор»
            $table->string('code', 50)->unique();
            $table->string('name', 100);
            // Карта «раздел → уровень»: none | view | edit
            $table->json('permissions')->nullable();
            $table->boolean('is_system')->default(false);
            $table->integer('sort_order')->default(0);
            $table->timestamps();
        });

        Schema::table('users', function (Blueprint $table) {
            $table->unsignedBigInteger('role_id')->nullable()->after('password');
            // Уволенного не удаляют — его операции остаются, и автор должен
            // читаться. Вместо удаления выключаем вход
            $table->boolean('is_active')->default(true)->after('role_id');
            $table->timestamp('last_login_at')->nullable()->after('is_active');
        });

        $now = now();
        foreach (Access::systemRoles() as $role) {
            DB::table('roles')->insert([
                'code'        => $role['code'],
                'name'        => $role['name'],
                'permissions' => json_encode($role['permissions']),
                'is_system'   => $role['is_system'],
                'sort_order'  => $role['sort_order'],
                'created_at'  => $now,
                'updated_at'  => $now,
            ]);
        }

        $adminId = DB::table('roles')->where('code', 'admin')->value('id');
        DB::table('users')->whereNull('role_id')->update(['role_id' => $adminId]);
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn(['role_id', 'is_active', 'last_login_at']);
        });

        Schema::dropIfExists('roles');
    }
};
