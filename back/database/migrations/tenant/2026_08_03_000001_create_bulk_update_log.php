<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Журнал массовых правок операций.
 *
 * Хранит прежние значения изменённых полей, чтобы правку можно было откатить:
 * массовое изменение — самое опасное действие, без отмены им страшно пользоваться.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('bulk_update_log', function (Blueprint $table) {
            $table->id();
            $table->json('filter');                 // условие отбора операций
            $table->json('changes_set');            // что проставляли (тип аналитики → id/название)
            $table->json('undo');                   // [{id, before:{поле:значение}}] — для отката
            $table->unsignedInteger('affected')->default(0);
            $table->string('description', 500)->nullable();
            $table->timestamp('reverted_at')->nullable();
            $table->unsignedBigInteger('created_by')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('bulk_update_log');
    }
};
