<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // 1. Добавляем признак количественного учёта в balance_items
        Schema::table('balance_items', function (Blueprint $table) {
            $table->boolean('has_quantity')->default(false)->after('is_system')
                ->comment('Признак количественного учёта. Кол-во записывается в balance_changes только для этих счетов.');
        });

        // 2. Проставляем has_quantity для товарных счетов
        DB::table('balance_items')
            ->whereIn('code', ['А200', 'А230', 'А240'])
            ->update(['has_quantity' => true]);

        // 3. Пересоздаём триггеры
        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS delete_changes');

        // INSERT: quantity пишем только если bi_id имеет has_quantity=1, со знаком как у amount
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

        // 4. Пересчитываем quantity в существующих balance_changes
        //    Для строк Дт (amount > 0): quantity = in_quantity если счёт has_quantity
        //    Для строк Кт (amount < 0): quantity = -out_quantity если счёт has_quantity
        DB::unprepared('
            UPDATE balance_changes bc
            JOIN operations op ON op.id = bc.operation_id
            JOIN balance_items bi ON bi.id = bc.bi_id
            SET bc.quantity = CASE
                WHEN bi.has_quantity = 1 AND bc.amount > 0 THEN  op.in_quantity
                WHEN bi.has_quantity = 1 AND bc.amount < 0 THEN -op.out_quantity
                ELSE 0
            END
        ');
    }

    public function down(): void
    {
        // Откатываем триггеры к старому виду (quantity = NEW.quantity, столбец note)
        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS delete_changes');

        DB::unprepared('
            CREATE TRIGGER insert_changes
            AFTER INSERT ON operations FOR EACH ROW
            BEGIN
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id,  NEW.amount,  NEW.quantity, NEW.in_bi_id,  NEW.in_info_1_id,  NEW.in_info_2_id,  NEW.in_info_3_id,  NEW.content);
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id, -NEW.amount,  NEW.quantity, NEW.out_bi_id, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id, NEW.content);
            END
        ');

        DB::unprepared('
            CREATE TRIGGER update_changes
            AFTER UPDATE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = NEW.id;
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id,  NEW.amount,  NEW.quantity, NEW.in_bi_id,  NEW.in_info_1_id,  NEW.in_info_2_id,  NEW.in_info_3_id,  NEW.content);
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id, -NEW.amount,  NEW.quantity, NEW.out_bi_id, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id, NEW.content);
            END
        ');

        DB::unprepared('
            CREATE TRIGGER delete_changes
            AFTER DELETE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = OLD.id;
            END
        ');

        Schema::table('balance_items', function (Blueprint $table) {
            $table->dropColumn('has_quantity');
        });
    }
};
