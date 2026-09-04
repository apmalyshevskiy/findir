<?php

use Database\Seeders\DocumentTypesSeeder;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Виды документов справочником.
 *
 * До этого вид документа был зашит в код: два типа, две стратегии проведения и
 * жёсткие списки допустимых счетов прямо в форме. Все документы при этом
 * устроены одинаково — счёт с аналитикой в шапке, счета с аналитикой и суммой в
 * строках, шапка в одну сторону, строки в противоположную. Различаются только
 * счета по умолчанию и набор колонок, а это данные, а не код.
 *
 * Поэтому вид документа переезжает в таблицу, а documents.type из перечисления
 * становится строкой: новые коды в enum не влезали бы.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('document_types', function (Blueprint $table) {
            $table->id();

            // Код попадает в documents.type и после создания не меняется:
            // на него ссылаются документы и импорт из учётных систем
            $table->string('code', 50)->unique();
            $table->string('name', 100);

            // Шапка: счёт по умолчанию и сторона, в которую он идёт.
            // Строки уходят в противоположную — этим приходная накладная
            // отличается от начисления ЗП при тех же счетах
            $table->unsignedBigInteger('head_bi_id')->nullable();
            $table->enum('head_side', ['debit', 'credit'])->default('credit');

            // Счёт строк по умолчанию: в самой строке его можно сменить
            $table->unsignedBigInteger('item_bi_id')->nullable();

            // Какие колонки показывать в строках. У начисления ЗП количества и
            // цены нет, у накладной есть — это разница вида, а не документа
            $table->boolean('show_quantity')->default(true);
            $table->boolean('show_price')->default(true);
            $table->boolean('show_vat')->default(false);

            // Движок проведения. 'universal' — шапка против строк, одна операция
            // на строку. 'outgoing_invoice' — своя логика в коде: выручка и
            // себестоимость, две операции на строку. Из интерфейса не меняется
            $table->string('engine', 30)->default('universal');

            // Системный вид нельзя удалить: за ним стоит код
            $table->boolean('is_system')->default(false);
            $table->boolean('is_active')->default(true);
            $table->integer('sort_order')->default(0);

            $table->timestamps();

            $table->index(['is_active', 'sort_order']);
        });

        // Перечисление → строка. Через сырой запрос: у ->change() на enum
        // поведение разъезжается между MySQL и MariaDB
        DB::statement("ALTER TABLE documents MODIFY type VARCHAR(50) NOT NULL");

        // Существующим базам план счетов уже засеян, поэтому счета видов
        // проставятся сразу. Новым базам этим займётся TenantDatabaseSeeder:
        // там миграции идут раньше сидеров и счетов ещё нет
        DocumentTypesSeeder::seedOn();
    }

    public function down(): void
    {
        Schema::dropIfExists('document_types');

        DB::statement(
            "ALTER TABLE documents MODIFY type ENUM('incoming_invoice','outgoing_invoice') NOT NULL"
        );
    }
};
