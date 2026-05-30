<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * payment_classification_rules — правила классификации строк выписки (ступень 1).
 *
 * Одна строка = одно правило «если сигналы совпали → категория».
 * Условия (заданные) соединяются по AND. Пустое условие = не проверять.
 *
 * Таблица рождается ПУСТОЙ. Наполняется тенантом вручную (UI) и в будущем —
 * автообучением из ручной разметки. Не засевается.
 *
 * Разноска (счёт + статья) живёт отдельно, в category_postings. Эта таблица
 * отвечает только за «как распознать», не за «куда проводить».
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payment_classification_rules', function (Blueprint $table) {
            $table->id();

            // ── Условия (AND) ──
            $table->string('direction', 8)->default('any');      // in | out | any
            $table->string('inn', 20)->nullable();               // точное совпадение ИНН контрагента
            $table->text('purpose_keywords')->nullable();        // список подстрок через | (contains, любая совпала)
            $table->boolean('has_kbk')->nullable();              // true = требовать заполненный КБК/статус (для TAX, шаг 3)
            $table->decimal('amount_min', 18, 2)->nullable();
            $table->decimal('amount_max', 18, 2)->nullable();

            // ── Результат ──
            $table->string('category', 32);                      // код категории из PaymentCategory

            // ── Служебное ──
            $table->integer('priority')->default(50);            // выше = раньше; первое совпадение побеждает
            $table->string('source', 16)->default('manual');     // manual | learned
            $table->unsignedBigInteger('hit_count')->default(0);
            $table->timestamp('last_applied_at')->nullable();
            $table->unsignedBigInteger('created_by')->nullable();
            $table->boolean('is_active')->default(true);
            $table->timestamps();

            $table->index(['is_active', 'priority']);
            $table->index('inn');
            $table->index('category');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('payment_classification_rules');
    }
};
