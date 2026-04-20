<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // MySQL: расширяем enum новым значением 'pdc' (платёжный календарь).
        // Используем сырой SQL, т.к. Doctrine не умеет ENUM из коробки.
        DB::statement("ALTER TABLE budget_documents MODIFY COLUMN type ENUM('dds','bdr','pdc') NOT NULL DEFAULT 'dds'");
    }

    public function down(): void
    {
        // Откат: убираем pdc. Перед откатом убедитесь, что в данных нет type='pdc',
        // иначе MySQL выдаст ошибку усечения данных.
        DB::statement("ALTER TABLE budget_documents MODIFY COLUMN type ENUM('dds','bdr') NOT NULL DEFAULT 'dds'");
    }
};
