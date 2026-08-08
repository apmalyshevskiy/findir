<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Каркас интеграций с учётными системами.
 *
 * Таблицы общие для всех источников, а специфика источника живёт в JSON
 * настроек и в классе-драйвере: вторая и третья интеграция не должны требовать
 * новой миграции.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('integrations', function (Blueprint $table) {
            $table->id();
            $table->string('type', 40);                 // fusionpos, ...
            $table->string('name');                     // «FusionPOS — кафе на Ленина»
            $table->boolean('is_active')->default(true);

            // Доступы храним зашифрованными (Crypt на APP_KEY) и одним полем:
            // у разных источников это разный набор — токен, логин+пароль, ключ
            $table->text('credentials')->nullable();

            // Сопоставление с планом счетов, проектом и справочниками
            $table->json('settings')->nullable();

            // Итог последней загрузки — чтобы список интеграций сразу показывал
            // состояние, не поднимая журнал
            $table->timestamp('last_run_at')->nullable();
            $table->string('last_run_status', 20)->nullable();   // ok | error
            $table->text('last_run_message')->nullable();

            $table->timestamps();
            $table->index('type');
        });

        /**
         * Связь «объект во внешней системе → наш документ».
         *
         * Без неё повторная загрузка за тот же период создала бы дубли, а
         * изменённую накладную было бы не с чем сопоставить.
         */
        Schema::create('integration_links', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('integration_id');
            $table->string('entity', 40);               // warehouse_invoice
            $table->string('external_id', 191);         // uuid во внешней системе
            $table->string('local_type', 40);           // document
            $table->unsignedBigInteger('local_id');

            // Отпечаток содержимого: если накладная не менялась, второй раз её
            // не трогаем — иначе каждая загрузка перепроводила бы всё подряд
            $table->string('fingerprint', 64)->nullable();
            $table->timestamp('synced_at')->nullable();
            $table->timestamps();

            $table->unique(['integration_id', 'entity', 'external_id'], 'integration_links_external_unique');
            $table->index(['local_type', 'local_id']);
            $table->foreign('integration_id')->references('id')->on('integrations')->cascadeOnDelete();
        });

        /** Журнал загрузок: что, когда, сколько и с какими предупреждениями. */
        Schema::create('integration_runs', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('integration_id');
            $table->string('entity', 40);
            $table->string('mode', 20)->default('manual');       // manual | scheduled
            $table->date('period_from')->nullable();
            $table->date('period_to')->nullable();
            $table->string('status', 20)->default('running');    // running | ok | error

            $table->unsignedInteger('fetched')->default(0);
            $table->unsignedInteger('created')->default(0);
            $table->unsignedInteger('updated')->default(0);
            $table->unsignedInteger('skipped')->default(0);
            $table->unsignedInteger('failed')->default(0);

            $table->text('message')->nullable();
            $table->json('details')->nullable();                  // построчные предупреждения
            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();
            $table->timestamps();

            $table->foreign('integration_id')->references('id')->on('integrations')->cascadeOnDelete();
            $table->index(['integration_id', 'id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('integration_runs');
        Schema::dropIfExists('integration_links');
        Schema::dropIfExists('integrations');
    }
};
