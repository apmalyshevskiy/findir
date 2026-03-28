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

        if (Schema::connection($conn)->hasColumn('budget_items', 'section')) {
            return; // уже применена
        }

        // 1. Добавить колонку section
        Schema::connection($conn)->table('budget_items', function (Blueprint $table) {
            $table->string('section', 20)->nullable()->after('article_id');
        });

        // 2. Найти FK constraint на budget_document_id
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

        // 3. Проверить наличие старого индекса
        $hasLookup = count(DB::connection($conn)->select(
            "SHOW INDEX FROM budget_items WHERE Key_name = 'budget_items_lookup'"
        )) > 0;

        if ($hasLookup) {
            // Убрать FK чтобы можно было удалить индекс
            if ($fkName) {
                DB::connection($conn)->statement("ALTER TABLE budget_items DROP FOREIGN KEY `{$fkName}`");
            }

            // Убрать старый индекс
            DB::connection($conn)->statement("ALTER TABLE budget_items DROP INDEX budget_items_lookup");

            // Создать новый индекс с section
            Schema::connection($conn)->table('budget_items', function (Blueprint $table) {
                $table->index(
                    ['budget_document_id', 'section', 'article_id', 'cash_id', 'period_date'],
                    'budget_items_lookup'
                );
            });

            // Вернуть FK
            if ($fkName) {
                DB::connection($conn)->statement("
                    ALTER TABLE budget_items
                    ADD CONSTRAINT `{$fkName}` FOREIGN KEY (budget_document_id)
                    REFERENCES budget_documents(id) ON DELETE CASCADE
                ");
            }
        } else {
            // Индекса нет — просто создаём новый
            Schema::connection($conn)->table('budget_items', function (Blueprint $table) {
                $table->index(
                    ['budget_document_id', 'section', 'article_id', 'cash_id', 'period_date'],
                    'budget_items_lookup'
                );
            });
        }
    }

    public function down(): void
    {
        $conn = Schema::getConnection()->getName();

        if (!Schema::connection($conn)->hasColumn('budget_items', 'section')) {
            return;
        }

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

        $hasLookup = count(DB::connection($conn)->select(
            "SHOW INDEX FROM budget_items WHERE Key_name = 'budget_items_lookup'"
        )) > 0;

        if ($hasLookup) {
            if ($fkName) {
                DB::connection($conn)->statement("ALTER TABLE budget_items DROP FOREIGN KEY `{$fkName}`");
            }
            DB::connection($conn)->statement("ALTER TABLE budget_items DROP INDEX budget_items_lookup");
        }

        Schema::connection($conn)->table('budget_items', function (Blueprint $table) {
            $table->dropColumn('section');
        });

        Schema::connection($conn)->table('budget_items', function (Blueprint $table) {
            $table->index(
                ['budget_document_id', 'article_id', 'cash_id', 'period_date'],
                'budget_items_lookup'
            );
        });

        if ($fkName) {
            DB::connection($conn)->statement("
                ALTER TABLE budget_items
                ADD CONSTRAINT `{$fkName}` FOREIGN KEY (budget_document_id)
                REFERENCES budget_documents(id) ON DELETE CASCADE
            ");
        }
    }
};
