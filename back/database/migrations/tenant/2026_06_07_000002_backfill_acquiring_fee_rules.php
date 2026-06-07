<?php

use App\Services\Acquiring\AcquiringFeeRules;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Бэкафилл: проставить дефолтные правила эквайринг-свода в settings уже
 * существующим тенантам. Новым тенантам это делает сидер при создании БД.
 *
 * Идемпотентно: ensureDefaults() пишет ТОЛЬКО если ключа ещё нет, поэтому
 * повторный прогон и уже отредактированные пользователем правила не трогаются.
 */
return new class extends Migration
{
    public function up(): void
    {
        $conn = Schema::getConnection()->getName();

        // На всякий случай: таблица settings должна существовать.
        if (!Schema::connection($conn)->hasTable('settings')) {
            return;
        }

        AcquiringFeeRules::ensureDefaults($conn);
    }

    public function down(): void
    {
        $conn = Schema::getConnection()->getName();

        if (!Schema::connection($conn)->hasTable('settings')) {
            return;
        }

        DB::connection($conn)
            ->table('settings')
            ->where('key', AcquiringFeeRules::SETTING_KEY)
            ->delete();
    }
};
