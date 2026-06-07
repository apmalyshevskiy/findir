<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Фикс: при удалении операции не очищались balance_changes.
 *
 * Причина. Модель Operation использует SoftDeletes, поэтому удаление через
 * Eloquent ($op->delete()) — это UPDATE operations SET deleted_at=NOW(), а не
 * DELETE. Из-за этого:
 *   - триггер delete_changes (AFTER DELETE) НЕ срабатывает;
 *   - срабатывает update_changes (AFTER UPDATE), который удаляет и тут же
 *     ЗАНОВО вставляет строки balance_changes.
 * Итог: «удалённая» операция остаётся в balance_changes и продолжает влиять
 * на остатки. (FK с ON DELETE CASCADE не помог бы — каскад тоже только на DELETE.)
 *
 * Решение. insert/update пишут balance_changes только когда строка не помечена
 * удалённой (deleted_at IS NULL). При soft-delete строки удаляются и не
 * пересоздаются; при восстановлении (deleted_at -> NULL) — пересоздаются.
 * delete_changes сохраняем для hard-delete (документы, forceDelete).
 *
 * Логика content/quantity перенесена без изменений из
 * 2026_03_21_000004_add_has_quantity_to_balance_items.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS delete_changes');

        // INSERT: пишем только для «живой» строки (deleted_at IS NULL).
        DB::unprepared('
            CREATE TRIGGER insert_changes
            AFTER INSERT ON operations FOR EACH ROW
            BEGIN
                IF NEW.deleted_at IS NULL THEN
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
                END IF;
            END
        ');

        // UPDATE: всегда чистим старые строки; пересоздаём ТОЛЬКО если строка
        // не помечена удалённой. Soft-delete => deleted_at NOT NULL => не пишем.
        // Restore (deleted_at -> NULL) и обычное редактирование => пишем заново.
        DB::unprepared('
            CREATE TRIGGER update_changes
            AFTER UPDATE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = NEW.id;
                IF NEW.deleted_at IS NULL THEN
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
                END IF;
            END
        ');

        // DELETE: для hard-delete (документы, forceDelete).
        DB::unprepared('
            CREATE TRIGGER delete_changes
            AFTER DELETE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = OLD.id;
            END
        ');

        // Чистим накопившийся мусор: balance_changes уже soft-deleted операций.
        DB::unprepared('
            DELETE bc FROM balance_changes bc
            JOIN operations op ON op.id = bc.operation_id
            WHERE op.deleted_at IS NOT NULL
        ');
    }

    public function down(): void
    {
        // Откат к версии без учёта deleted_at (как в 2026_03_21_000004).
        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS delete_changes');

        DB::unprepared('
            CREATE TRIGGER insert_changes
            AFTER INSERT ON operations FOR EACH ROW
            BEGIN
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
            END
        ');

        DB::unprepared('
            CREATE TRIGGER update_changes
            AFTER UPDATE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = NEW.id;
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
            END
        ');

        DB::unprepared('
            CREATE TRIGGER delete_changes
            AFTER DELETE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = OLD.id;
            END
        ');
    }
};
