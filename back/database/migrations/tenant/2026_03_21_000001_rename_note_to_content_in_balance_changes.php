<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Переименовываем поле
        Schema::table('balance_changes', function (Blueprint $table) {
            $table->renameColumn('note', 'content');
        });

        // Пересоздаём триггеры — теперь пишут content из operations.content
        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS delete_changes');

        DB::unprepared('
            CREATE TRIGGER insert_changes
            AFTER INSERT ON operations FOR EACH ROW
            BEGIN
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id,  NEW.amount, NEW.quantity, NEW.in_bi_id,  NEW.in_info_1_id,  NEW.in_info_2_id,  NEW.in_info_3_id,  NEW.content);
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id, -NEW.amount, NEW.quantity, NEW.out_bi_id, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id, NEW.content);
            END
        ');

        DB::unprepared('
            CREATE TRIGGER update_changes
            AFTER UPDATE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = NEW.id;
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id,  NEW.amount, NEW.quantity, NEW.in_bi_id,  NEW.in_info_1_id,  NEW.in_info_2_id,  NEW.in_info_3_id,  NEW.content);
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, content)
                VALUES (NEW.id, NEW.date, NEW.project_id, -NEW.amount, NEW.quantity, NEW.out_bi_id, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id, NEW.content);
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

    public function down(): void
    {
        Schema::table('balance_changes', function (Blueprint $table) {
            $table->renameColumn('content', 'note');
        });

        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS delete_changes');

        DB::unprepared('
            CREATE TRIGGER insert_changes
            AFTER INSERT ON operations FOR EACH ROW
            BEGIN
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, note)
                VALUES (NEW.id, NEW.date, NEW.project_id,  NEW.amount, NEW.quantity, NEW.in_bi_id,  NEW.in_info_1_id,  NEW.in_info_2_id,  NEW.in_info_3_id,  NEW.note);
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, note)
                VALUES (NEW.id, NEW.date, NEW.project_id, -NEW.amount, NEW.quantity, NEW.out_bi_id, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id, NEW.note);
            END
        ');

        DB::unprepared('
            CREATE TRIGGER update_changes
            AFTER UPDATE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = NEW.id;
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, note)
                VALUES (NEW.id, NEW.date, NEW.project_id,  NEW.amount, NEW.quantity, NEW.in_bi_id,  NEW.in_info_1_id,  NEW.in_info_2_id,  NEW.in_info_3_id,  NEW.note);
                INSERT INTO balance_changes (operation_id, date, project_id, amount, quantity, bi_id, info_1_id, info_2_id, info_3_id, note)
                VALUES (NEW.id, NEW.date, NEW.project_id, -NEW.amount, NEW.quantity, NEW.out_bi_id, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id, NEW.note);
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
