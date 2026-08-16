<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Сторона проводки в оборотах — явно, а не по знаку суммы.
 *
 * Раньше отчёты восстанавливали дебет и кредит из знака: «плюс — дебет,
 * минус — кредит». Пока все суммы положительные, знак и сторона совпадают.
 * Но минус — это сторно: проводка Дт А100 Кт П550 на −60 должна ГАСИТЬ
 * дебетовый оборот А100, а не создавать кредитовый. По знаку выходило
 * наоборот, и сторно раздувало обороты сразу с двух сторон.
 *
 * Теперь триггер пишет сторону по слоту счёта в операции: попал в дебет —
 * значит дебет, какой бы ни была сумма.
 *
 * Сумма остаётся знаковой, поэтому арифметика остатков не меняется вовсе:
 * сальдо счёта — это по-прежнему SUM(amount). Обороты считаются так:
 *     дебет  =  SUM(amount)  где side = 'debit'
 *     кредит = -SUM(amount)  где side = 'credit'
 * На положительных суммах это даёт ровно прежние числа.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Столбец мог остаться от прерванного запуска — миграция должна
        // переживать повтор
        if (Schema::hasColumn('balance_changes', 'side')) {
            Schema::table('balance_changes', fn(Blueprint $t) => $t->dropColumn('side'));
        }

        /**
         * Таблицу пересобираем целиком, а не дописываем сторону.
         *
         * У balance_changes нет первичного ключа: две строки одной операции
         * различить нечем, и «первая — дебет, вторая — кредит» здесь не
         * работает. Зато таблица производная — её можно построить из операций
         * заново, ровно тем же правилом, что и триггер. Заодно уйдут
         * осиротевшие строки, если такие накопились.
         */
        DB::table('balance_changes')->delete();

        Schema::table('balance_changes', function (Blueprint $table) {
            $table->enum('side', ['debit', 'credit'])->after('bi_id');
        });

        $this->rebuild();
        $this->createTriggers(withSide: true);
    }

    public function down(): void
    {
        $this->createTriggers(withSide: false);

        DB::table('balance_changes')->delete();
        Schema::table('balance_changes', fn(Blueprint $t) => $t->dropColumn('side'));

        // Пересобираем без стороны — тем же запросом, но без колонки
        $this->rebuild(withSide: false);
    }

    /** Собрать обороты из операций — то же правило, что в триггерах. */
    private function rebuild(bool $withSide = true): void
    {
        $col  = $withSide ? ', side' : '';
        $gate = 'op.deleted_at IS NULL AND op.is_posted = 1';

        foreach ([['debit', 'in'], ['credit', 'out']] as [$side, $slot]) {
            $sign  = $slot === 'in' ? '' : '-';
            $value = $withSide ? ", '{$side}'" : '';

            // LEFT JOIN + COALESCE: если счёт куда-то делся, строку всё равно
            // создаём с нулевым количеством — как повёл бы себя триггер
            DB::unprepared("
                INSERT INTO balance_changes
                    (operation_id, date, project_id, amount, quantity, bi_id{$col},
                     info_1_id, info_2_id, info_3_id, content)
                SELECT
                    op.id, op.date, op.project_id,
                    {$sign}op.amount,
                    COALESCE(CASE WHEN bi.has_quantity THEN {$sign}op.{$slot}_quantity ELSE 0 END, 0),
                    op.{$slot}_bi_id{$value},
                    op.{$slot}_info_1_id, op.{$slot}_info_2_id, op.{$slot}_info_3_id,
                    op.content
                FROM operations op
                LEFT JOIN balance_items bi ON bi.id = op.{$slot}_bi_id
                WHERE {$gate}
            ");
        }
    }

    /** Триггеры целиком: MySQL умеет только пересоздавать их. */
    private function createTriggers(bool $withSide): void
    {
        $sideCol   = $withSide ? ', side' : '';
        $sideDebit = $withSide ? ", 'debit'" : '';
        $sideCred  = $withSide ? ", 'credit'" : '';

        $rows = "
            INSERT INTO balance_changes
                (operation_id, date, project_id, amount, quantity, bi_id{$sideCol}, info_1_id, info_2_id, info_3_id, content)
            VALUES (
                NEW.id, NEW.date, NEW.project_id,
                NEW.amount,
                (SELECT CASE WHEN bi.has_quantity THEN NEW.in_quantity ELSE 0 END
                 FROM balance_items bi WHERE bi.id = NEW.in_bi_id),
                NEW.in_bi_id{$sideDebit}, NEW.in_info_1_id, NEW.in_info_2_id, NEW.in_info_3_id,
                NEW.content
            );
            INSERT INTO balance_changes
                (operation_id, date, project_id, amount, quantity, bi_id{$sideCol}, info_1_id, info_2_id, info_3_id, content)
            VALUES (
                NEW.id, NEW.date, NEW.project_id,
                -NEW.amount,
                (SELECT CASE WHEN bi.has_quantity THEN -NEW.out_quantity ELSE 0 END
                 FROM balance_items bi WHERE bi.id = NEW.out_bi_id),
                NEW.out_bi_id{$sideCred}, NEW.out_info_1_id, NEW.out_info_2_id, NEW.out_info_3_id,
                NEW.content
            );
        ";

        $gate = 'NEW.deleted_at IS NULL AND NEW.is_posted = 1';

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
