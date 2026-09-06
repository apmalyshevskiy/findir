<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Соответствие «счёт 1С → счёт FINDIR».
 *
 * Отдельной таблицей, а не полем в настройках: строк тут десятки, они читаются
 * на каждую проводку и по ним же строится список несопоставленного. В JSON это
 * пришлось бы разворачивать целиком ради одного счёта.
 *
 * Заполняется один раз. Дальше файлы за новые периоды грузятся молча — пока в
 * 1С не появится счёт, которого мы ещё не видели.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('onec_account_map', function (Blueprint $table) {
            $table->id();

            // Код счёта 1С как он лежит в выгрузке: «10.01», «60.01», «90.02.1»
            $table->string('account', 20);
            $table->unsignedBigInteger('bi_id');

            $table->timestamps();

            $table->unique('account');
            $table->foreign('bi_id')->references('id')->on('balance_items')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('onec_account_map');
    }
};
