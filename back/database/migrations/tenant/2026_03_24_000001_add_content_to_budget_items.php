<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $conn = Schema::getConnection()->getName();

        // 1. Добавить content если нет
        if (!Schema::connection($conn)->hasColumn('budget_items', 'content')) {
            Schema::connection($conn)->table('budget_items', function (Blueprint $table) {
                $table->string('content', 500)->nullable()->after('period_date');
            });
        }

        // 2. Найти имя FK constraint на budget_document_id
        $fkName = null;
        $fks = DB::connection($conn)->select("
            SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'budget_items'
              AND COLUMN_NAME = 'budget_document_id'
              AND REFERENCED_TABLE_NAME IS NOT NULL
        ");
        if (count($fks) > 0) {
            $fkName = $fks[0]->CONSTRAINT_NAME;
        }

        // 3. Проверить наличие unique key
        $hasUnique = count(DB::connection($conn)->select(
            "SHOW INDEX FROM budget_items WHERE Key_name = 'budget_items_unique'"
        )) > 0;

        if ($hasUnique) {
            // Убрать FK чтобы можно было удалить unique index
            if ($fkName) {
                DB::connection($conn)->statement("ALTER TABLE budget_items DROP FOREIGN KEY `{$fkName}`");
            }

            // Убрать unique
            DB::connection($conn)->statement("ALTER TABLE budget_items DROP INDEX budget_items_unique");

            // Вернуть FK
            if ($fkName) {
                DB::connection($conn)->statement("
                    ALTER TABLE budget_items
                    ADD CONSTRAINT `{$fkName}` FOREIGN KEY (budget_document_id)
                    REFERENCES budget_documents(id) ON DELETE CASCADE
                ");
            }
        }

        // 4. Добавить обычный индекс если нет
        $hasLookup = count(DB::connection($conn)->select(
            "SHOW INDEX FROM budget_items WHERE Key_name = 'budget_items_lookup'"
        )) > 0;

        if (!$hasLookup) {
            Schema::connection($conn)->table('budget_items', function (Blueprint $table) {
                $table->index(['budget_document_id', 'article_id', 'cash_id', 'period_date'], 'budget_items_lookup');
            });
        }
    }

    public function down(): void
    {
        Schema::table('budget_items', function (Blueprint $table) {
            $table->dropIndex('budget_items_lookup');
            $table->dropColumn('content');
            $table->unique(['budget_document_id', 'article_id', 'cash_id', 'period_date'], 'budget_items_unique');
        });
    }
};
