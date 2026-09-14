<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * История изменений объектов: операций, документов, справочников.
 *
 * Хранится и разница (что на что поменялось — для чтения), и полный снимок
 * объекта после изменения (для восстановления). Снимок вместо цепочки
 * разностей: объектов тысячи, а не миллионы, место ничего не стоит, зато
 * вернуть версию — это записать её снимок, а не разворачивать назад всю
 * историю, где одна битая ссылка ломает всё позади себя.
 *
 * `source` и `batch` обязательны по существу: перезагрузка 1С правит десятки
 * операций разом, выписка создаёт сотни. Без пометки, откуда пришло изменение,
 * журнал утонет в строках, за которыми не видно ручных правок.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('object_versions', function (Blueprint $table) {
            $table->id();

            // 'operation' | 'document' | 'info'
            $table->string('entity', 20);
            $table->unsignedBigInteger('entity_id');
            // Порядковый номер в пределах объекта: на него ссылается «восстановлено из версии N»
            $table->unsignedInteger('version');

            // 'created' | 'updated' | 'deleted' | 'restored'
            $table->string('action', 10);

            $table->json('diff');       // [{field, was, now}] — пусто у created
            $table->json('snapshot');   // полное состояние после изменения

            // manual | ai | bulk | onec | statement | document | import
            $table->string('source', 20)->default('manual');
            // Одна пачка — одно действие человека: «загрузка 1С», «массовая правка»
            $table->string('batch', 40)->nullable();

            // Пусто у изменений из очереди и расписания: там нет человека
            $table->unsignedBigInteger('user_id')->nullable();
            // Версия, из которой восстановили, — только у action = 'restored'
            $table->unsignedInteger('restored_from')->nullable();

            $table->timestamp('created_at')->useCurrent();

            $table->unique(['entity', 'entity_id', 'version']);
            $table->index(['entity', 'entity_id', 'id']);
            $table->index('batch');
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('object_versions');
    }
};
