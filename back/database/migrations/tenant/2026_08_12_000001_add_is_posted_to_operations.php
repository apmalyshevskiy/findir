<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Проведение операции.
 *
 * Непроведённая операция видна в списке, но в обороты не попадает: её нет в
 * balance_changes, а значит нет ни в оборотке, ни в отчётах, ни в остатках.
 * Так можно завести операцию заранее или отложить спорную, не искажая цифры.
 *
 * Механика та же, что уже работает для удалённых: триггеры пишут обороты
 * только для «настоящей» строки. К условию deleted_at IS NULL добавляется
 * is_posted = 1 — отдельной логики не появляется.
 *
 * Все существующие операции становятся проведёнными: цифры в отчётах после
 * миграции обязаны остаться теми же.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('operations', function (Blueprint $table) {
            $table->boolean('is_posted')->default(true)->after('source');
            $table->index(['project_id', 'is_posted']);
        });

        $this->createTriggers(posted: true);
    }

    public function down(): void
    {
        $this->createTriggers(posted: false);

        Schema::table('operations', function (Blueprint $table) {
            $table->dropIndex(['project_id', 'is_posted']);
            $table->dropColumn('is_posted');
        });
    }

    /**
     * Триггеры целиком: MySQL не умеет менять тело, только пересоздавать.
     *
     * $posted — учитывать ли новый флаг. При откате миграции колонки уже
     * не будет, и упоминание её в триггере сломало бы вставку операций.
     */
    private function createTriggers(bool $posted): void
    {
        $gate = $posted
            ? 'NEW.deleted_at IS NULL AND NEW.is_posted = 1'
            : 'NEW.deleted_at IS NULL';

        $rows = '
            INSERT INTO balance_changes
                (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
            VALUES (
                NEW.id, NEW.date, NEW.project_id,
                NEW.amount,
                (SELECT CASE WHEN bi.has_quantity THEN NEW.in_quantity ELSE 0 END
                 FROM balance_items bi WHERE bi.id = NEW.in_bi_id),
                NEW.in_bi_id, NEW.in_info_1_id, NEW.in_info_2_id, NEW.in_info_3_id,
                NEW.content
            );
            INSERT INTO balance_changes
                (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
            VALUES (
                NEW.id, NEW.date, NEW.project_id,
                -NEW.amount,
                (SELECT CASE WHEN bi.has_quantity THEN -NEW.out_quantity ELSE 0 END
                 FROM balance_items bi WHERE bi.id = NEW.out_bi_id),
                NEW.out_bi_id, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id,
                NEW.content
            );
        ';

        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS delete_changes');

        DB::unprepared("
            CREATE TRIGGER insert_changes
            AFTER INSERT ON operations FOR EACH ROW
            BEGIN
                IF {$gate} THEN
                    {$rows}
                END IF;
            END
        ");

        // Старые строки чистим всегда: снятие проведения — это тоже UPDATE,
        // и обороты по нему должны исчезнуть
        DB::unprepared("
            CREATE TRIGGER update_changes
            AFTER UPDATE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = NEW.id;
                IF {$gate} THEN
                    {$rows}
                END IF;
            END
        ");

        DB::unprepared('
            CREATE TRIGGER delete_changes
            AFTER DELETE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = OLD.id;
            END
        ');
    }
};
