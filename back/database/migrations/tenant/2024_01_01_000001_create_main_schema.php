<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('projects', function (Blueprint $table) {
            $table->id();
            $table->bigInteger('parent_id')->nullable();
            $table->string('name');
            $table->char('currency', 3)->default('RUB');
            $table->string('timezone', 50)->default('Europe/Moscow');
            $table->timestamps();
            $table->softDeletes();
        });

        Schema::create('info', function (Blueprint $table) {
            $table->id();
            $table->bigInteger('parent_id')->nullable()->index();
            $table->string('code', 35)->nullable();
            $table->string('name');
            $table->enum('type', ['partner','employee','department','cash','flow','expenses','product','revenue']);
            $table->text('description')->nullable();
            $table->boolean('is_active')->default(true);
            $table->timestamps();
            $table->softDeletes();
        });

        Schema::create('balance_items', function (Blueprint $table) {
            $table->id();
            $table->bigInteger('parent_id')->nullable();
            $table->string('name');
            $table->string('code', 10);
            $table->enum('info_1_type', ['partner','employee','department','cash','flow','expenses','product','revenue'])->nullable();
            $table->enum('info_2_type', ['partner','employee','department','cash','flow','expenses','product','revenue'])->nullable();
            $table->enum('info_3_type', ['partner','employee','department','cash','flow','expenses','product','revenue'])->nullable();
            $table->boolean('is_system')->default(false);
            $table->timestamps();
            $table->softDeletes();
        });

        Schema::create('operations', function (Blueprint $table) {
            $table->id();
            $table->timestamp('date');
            $table->unsignedBigInteger('project_id');
            $table->double('amount', 15, 2)->default(0);
            $table->double('quantity', 15, 3)->default(0);
            $table->unsignedBigInteger('in_bi_id');
            $table->unsignedBigInteger('in_info_1_id')->nullable();
            $table->unsignedBigInteger('in_info_2_id')->nullable();
            $table->unsignedBigInteger('in_info_3_id')->nullable();
            $table->double('in_quantity', 15, 3)->default(0);
            $table->unsignedBigInteger('out_bi_id');
            $table->unsignedBigInteger('out_info_1_id')->nullable();
            $table->unsignedBigInteger('out_info_2_id')->nullable();
            $table->unsignedBigInteger('out_info_3_id')->nullable();
            $table->double('out_quantity', 15, 3)->default(0);
            $table->text('note')->nullable();
            $table->string('source', 20)->default('manual');
            $table->string('external_id', 100)->nullable()->unique();
            $table->string('table_name', 50)->nullable();
            $table->string('table_id', 36)->nullable();
            $table->timestamps();
            $table->softDeletes();
            $table->index(['project_id', 'date']);
            $table->index('in_bi_id');
            $table->index('out_bi_id');
        });

        Schema::create('balance_changes', function (Blueprint $table) {
            $table->unsignedBigInteger('operation_id');
            $table->timestamp('date');
            $table->unsignedBigInteger('project_id');
            $table->double('amount', 15, 2);
            $table->double('quantity', 15, 3);
            $table->unsignedBigInteger('bi_id');
            $table->unsignedBigInteger('info_1_id')->nullable();
            $table->unsignedBigInteger('info_2_id')->nullable();
            $table->unsignedBigInteger('info_3_id')->nullable();
            $table->text('note')->nullable();
            $table->index(['project_id', 'date']);
            $table->index('bi_id');
            $table->index('operation_id');
        });

        Schema::create('balance', function (Blueprint $table) {
            $table->id();
            $table->datetime('date');
            $table->unsignedBigInteger('project_id');
            $table->double('amount', 15, 2);
            $table->double('quantity', 15, 3);
            $table->unsignedBigInteger('bi_id');
            $table->unsignedBigInteger('info_1_id')->nullable();
            $table->unsignedBigInteger('info_2_id')->nullable();
            $table->unsignedBigInteger('info_3_id')->nullable();
            $table->timestamps();
            $table->index(['project_id', 'date', 'bi_id']);
        });

        // Триггеры
        DB::unprepared('
            CREATE TRIGGER insert_changes
            AFTER INSERT ON operations FOR EACH ROW
            BEGIN
                INSERT INTO balance_changes (operation_id,date,project_id,amount,quantity,bi_id,info_1_id,info_2_id,info_3_id,note)
                VALUES (NEW.id,NEW.date,NEW.project_id,NEW.amount,NEW.quantity,NEW.in_bi_id,NEW.in_info_1_id,NEW.in_info_2_id,NEW.in_info_3_id,NEW.note),
                       (NEW.id,NEW.date,NEW.project_id,-NEW.amount,-NEW.quantity,NEW.out_bi_id,NEW.out_info_1_id,NEW.out_info_2_id,NEW.out_info_3_id,NEW.note);
            END
        ');

        DB::unprepared('
            CREATE TRIGGER update_changes
            AFTER UPDATE ON operations FOR EACH ROW
            BEGIN
                DELETE FROM balance_changes WHERE operation_id = OLD.id;
                IF NEW.deleted_at IS NULL THEN
                    INSERT INTO balance_changes (operation_id,date,project_id,amount,quantity,bi_id,info_1_id,info_2_id,info_3_id,note)
                    VALUES (NEW.id,NEW.date,NEW.project_id,NEW.amount,NEW.quantity,NEW.in_bi_id,NEW.in_info_1_id,NEW.in_info_2_id,NEW.in_info_3_id,NEW.note),
                           (NEW.id,NEW.date,NEW.project_id,-NEW.amount,-NEW.quantity,NEW.out_bi_id,NEW.out_info_1_id,NEW.out_info_2_id,NEW.out_info_3_id,NEW.note);
                END IF;
            END
        ');
    }

    public function down(): void
    {
        DB::unprepared('DROP TRIGGER IF EXISTS update_changes');
        DB::unprepared('DROP TRIGGER IF EXISTS insert_changes');
        Schema::dropIfExists('balance');
        Schema::dropIfExists('balance_changes');
        Schema::dropIfExists('operations');
        Schema::dropIfExists('balance_items');
        Schema::dropIfExists('info');
        Schema::dropIfExists('projects');
    }
};
