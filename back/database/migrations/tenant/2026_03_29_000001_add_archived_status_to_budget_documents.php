<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $conn = DB::connection()->getName();
        DB::connection($conn)->statement("ALTER TABLE budget_documents MODIFY COLUMN status ENUM('draft','approved','archived') NOT NULL DEFAULT 'draft'");
    }

    public function down(): void
    {
        $conn = DB::connection()->getName();
        // Вернуть archived → draft перед сужением ENUM
        DB::connection($conn)->table('budget_documents')->where('status', 'archived')->update(['status' => 'draft']);
        DB::connection($conn)->statement("ALTER TABLE budget_documents MODIFY COLUMN status ENUM('draft','approved') NOT NULL DEFAULT 'draft'");
    }
};
