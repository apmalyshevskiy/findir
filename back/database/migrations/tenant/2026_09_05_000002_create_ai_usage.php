<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Расход на ИИ.
 *
 * Шлюз возвращает потраченные токены в каждом ответе, но до сих пор это число
 * долетало до браузера и терялось: посчитать, во что обошёлся месяц работы с
 * ИИ, было нечем.
 *
 * Пишем по строке на вызов. Стоимость храним в себестоимости — как её отдал
 * шлюз; наценка живёт в настройке и применяется при показе, иначе смена наценки
 * задним числом переписывала бы историю.
 *
 * `raw` — сырой ответ шлюза про расход. Нужен, пока не выяснено доподлинно,
 * что именно RouterAI кладёт в usage у разных моделей: по нему видно, откуда
 * взялась цифра, и можно пересчитать, если разберём формат точнее.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_usage', function (Blueprint $table) {
            $table->id();

            // Что делали: operation — ввод операции, file — разбор файла,
            // statement — классификация выписки, transcribe — распознавание речи
            $table->string('feature', 30);
            $table->string('model', 100)->nullable();

            $table->unsignedInteger('input_tokens')->default(0);
            $table->unsignedInteger('output_tokens')->default(0);
            $table->unsignedInteger('total_tokens')->default(0);

            // Себестоимость по данным шлюза. NULL — шлюз стоимость не вернул
            $table->decimal('cost', 12, 6)->nullable();
            $table->string('currency', 8)->nullable();

            $table->json('raw')->nullable();

            // Кто именно потратил — пригодится, когда в компании несколько человек
            $table->unsignedBigInteger('user_id')->nullable();

            $table->timestamps();

            $table->index('created_at');
            $table->index(['feature', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_usage');
    }
};
