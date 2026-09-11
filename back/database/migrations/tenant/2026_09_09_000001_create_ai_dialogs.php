<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Диалоги с ИИ-помощником.
 *
 * До сих пор диалог жил только в браузере: одна лента на компанию, 12 часов,
 * привязка к одному компьютеру. Ответ на счёт даёт несколько черновиков, вносят
 * их по очереди, и «Начать заново» уничтожало ещё не разобранные — вместе со
 * всей перепиской.
 *
 * Лента лежит одним JSON-полем, без таблицы реплик. Фронт работает с ней как с
 * целым: по отдельной реплике никто не ищет и не отчитывается, а расход по
 * вызовам уже разложен по строкам в `ai_usage` — вторая нормализованная копия
 * не нужна.
 *
 * Счётчики черновиков и стоимость дублируют то, что есть внутри `turns`:
 * список диалогов должен показывать «записано 3 из 4», не разбирая JSON
 * каждой строки.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_dialogs', function (Blueprint $table) {
            $table->id();

            // Автор. Диалог — черновая работа, и видит его только он:
            // выборки фильтруются по этому полю
            $table->unsignedBigInteger('user_id')->nullable();

            // Первая реплика человека, обрезанная. Считает сервер при
            // сохранении, чтобы правило было одно
            $table->string('title', 255)->default('');

            // Лента: реплики, черновики, показатели, отметки «записана»
            $table->json('turns')->nullable();
            // Контекст для модели — то, что уходит в history запроса
            $table->json('history')->nullable();

            $table->unsignedSmallInteger('drafts_total')->default(0);
            $table->unsignedSmallInteger('drafts_saved')->default(0);

            // Во что обошёлся диалог — сумма цен ответов, как их видел человек
            // в чате (наценка уже применена). Себестоимость лежит в ai_usage:
            // здесь она была бы второй, расходящейся правдой
            $table->decimal('cost', 12, 6)->nullable();
            $table->unsignedInteger('total_tokens')->default(0);

            $table->timestamps();

            $table->index(['user_id', 'updated_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_dialogs');
    }
};
