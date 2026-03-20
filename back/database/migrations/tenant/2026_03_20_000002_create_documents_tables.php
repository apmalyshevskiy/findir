<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('documents', function (Blueprint $table) {
            $table->id();
            $table->date('date');
            $table->string('number', 50)->nullable();
            $table->unsignedBigInteger('project_id');
            $table->enum('type', ['incoming_invoice', 'outgoing_invoice']);
            $table->enum('status', ['draft', 'posted', 'cancelled'])->default('draft');

            // Автор документа — заполняется из текущего пользователя при создании
            $table->unsignedBigInteger('created_by')->nullable();

            // Счёт и аналитика шапки.
            // incoming_invoice: bi_id = П100 Поставщики, info_1_id = Поставщик
            // outgoing_invoice: bi_id = А405 Клиенты,    info_1_id = Покупатель
            // Видимость info_1/2/3 определяется через balance_items.info_N_type
            $table->unsignedBigInteger('bi_id');
            $table->unsignedBigInteger('info_1_id')->nullable();
            $table->unsignedBigInteger('info_2_id')->nullable();
            $table->unsignedBigInteger('info_3_id')->nullable();

            // Поля только для outgoing_invoice.
            // Копируются из project при создании документа и фиксируются навсегда.
            // Если в project пусто — в документе тоже пусто (пользователь заполняет вручную).
            $table->unsignedBigInteger('revenue_bi_id')->nullable();      // П587 Доходы
            $table->unsignedBigInteger('cogs_bi_id')->nullable();          // П588 Себестоимость
            $table->unsignedBigInteger('revenue_item_id')->nullable();     // Статья дохода info(revenue)

            // Суммы — денормализация из строк, пересчитываются при проведении
            $table->decimal('amount', 15, 2)->default(0);
            $table->decimal('amount_vat', 15, 2)->nullable();

            // Текст
            $table->text('content')->nullable();  // авто: «Поступление от ООО Ромашка №123»
            $table->text('note')->nullable();      // комментарий пользователя
            $table->json('extra')->nullable();     // специфика типа, будущие расширения

            $table->timestamps();
            $table->softDeletes();

            $table->index(['project_id', 'date']);
            $table->index(['project_id', 'type', 'status']);
            $table->index(['project_id', 'status']);
            $table->index('bi_id');
            $table->index('created_by');
        });

        Schema::create('document_items', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('document_id');
            $table->integer('sort_order')->default(0);

            // Корреспондирующий счёт строки — вторая сторона проводки.
            // incoming_invoice: bi_id = А200/А230, подаётся в Дт
            // outgoing_invoice: bi_id = А200/А240, подаётся в Кт
            // Видимость info_1/2/3 определяется через balance_items.info_N_type
            // А200: info_1=product(номенклатура), info_2=department(склад)
            // А230: info_1=product(номенклатура), info_2=null
            // А240: info_1=product(номенклатура), info_2=null
            $table->unsignedBigInteger('bi_id');
            $table->unsignedBigInteger('info_1_id')->nullable();  // номенклатура
            $table->unsignedBigInteger('info_2_id')->nullable();  // склад (если есть у счёта)
            $table->unsignedBigInteger('info_3_id')->nullable();  // доп. аналитика

            // Суммы
            $table->decimal('quantity', 15, 3)->default(0);
            $table->decimal('price', 15, 4)->default(0);
            $table->decimal('amount', 15, 2)->default(0);          // сумма продажи / прихода
            $table->decimal('amount_vat', 15, 2)->nullable();      // НДС строки
            $table->decimal('amount_cost', 15, 2)->nullable();     // себестоимость — только outgoing_invoice

            // Текст
            $table->text('content')->nullable();  // авто
            $table->text('note')->nullable();      // комментарий пользователя

            $table->timestamps();

            $table->foreign('document_id')
                ->references('id')
                ->on('documents')
                ->cascadeOnDelete();

            $table->index(['document_id', 'sort_order']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('document_items');
        Schema::dropIfExists('documents');
    }
};
