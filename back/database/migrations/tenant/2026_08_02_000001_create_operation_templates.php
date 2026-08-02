<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Шаблоны операций: сохранённый ввод, который можно повторить одной кнопкой
 * в следующем месяце (аренда, зарплата, регулярные платежи).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('operation_templates', function (Blueprint $table) {
            $table->id();
            $table->string('name');                              // короткая фраза для кнопки
            $table->json('payload');                             // поля операции (счета, аналитика, сумма)
            $table->unsignedInteger('use_count')->default(0);
            $table->timestamp('last_used_at')->nullable();
            $table->integer('sort_order')->default(0);
            $table->timestamps();
            $table->softDeletes();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('operation_templates');
    }
};
