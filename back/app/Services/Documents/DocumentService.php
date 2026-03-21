<?php

namespace App\Services\Documents;

use App\Models\Tenant\Document;
use Illuminate\Support\Facades\DB;

class DocumentService
{
    /**
     * Получить стратегию по типу документа.
     */
    public static function strategy(string $type): DocumentStrategyInterface
    {
        return match ($type) {
            'incoming_invoice' => new IncomingInvoiceStrategy(),
            'outgoing_invoice' => new OutgoingInvoiceStrategy(),
            default => throw new \InvalidArgumentException("Неизвестный тип документа: {$type}"),
        };
    }

    /**
     * Заполнить поля outgoing_invoice из настроек проекта.
     * Вызывается при создании документа типа outgoing_invoice.
     * Значения фиксируются навсегда — project не читается при проведении.
     */
    public static function fillFromProject(Document $document): void
    {
        if ($document->type !== 'outgoing_invoice') {
            return;
        }

        $project = DB::connection($document->getConnectionName())
            ->table('projects')
            ->where('id', $document->project_id)
            ->first();

        if (!$project) {
            return;
        }

        // Копируем только если поле в документе ещё не заполнено
        // (позволяет передать явные значения через API и не перезатереть их)
        if (!$document->revenue_bi_id && $project->outgoing_revenue_bi_id) {
            $document->revenue_bi_id = $project->outgoing_revenue_bi_id;
        }
        if (!$document->cogs_bi_id && $project->outgoing_cogs_bi_id) {
            $document->cogs_bi_id = $project->outgoing_cogs_bi_id;
        }
        if (!$document->revenue_item_id && $project->outgoing_revenue_item_id) {
            $document->revenue_item_id = $project->outgoing_revenue_item_id;
        }
    }

    /**
     * Провести документ:
     * 1. Удалить старые операции
     * 2. Пересчитать итоги шапки из строк
     * 3. Сгенерировать content
     * 4. Создать новые операции
     * 5. Установить status = posted
     */
    public static function post(Document $document): void
    {
        $conn = $document->getConnectionName();

        DB::connection($conn)->transaction(function () use ($document, $conn) {
            // 1. Удаляем старые операции (hard delete)
            DB::connection($conn)
                ->table('operations')
                ->where('table_name', 'documents')
                ->where('table_id', (string) $document->id)
                ->delete();

            // 2. Пересчитываем итоги из строк
            $document->amount = DB::connection($conn)
                ->table('document_items')
                ->where('document_id', $document->id)
                ->sum('amount');

            $vatSum = DB::connection($conn)
                ->table('document_items')
                ->where('document_id', $document->id)
                ->whereNotNull('amount_vat')
                ->sum('amount_vat');

            $document->amount_vat = $vatSum > 0 ? $vatSum : null;

            // 3. Генерируем content шапки
            $strategy = self::strategy($document->type);
            $document->content = $strategy->buildContent($document);
            $document->status  = 'posted';
            $document->save();

            // 4. Строим операции и вставляем
            $operations = $strategy->buildOperations($document);

            if (empty($operations)) {
                return;
            }

            $now  = now();

            // Нормализуем каждую строку — Laravel bulk insert требует одинаковых ключей
            // во всех строках, иначе NULL передаётся для несовпадающих полей
            $baseRow = [
                'date'          => null,
                'project_id'    => null,
                'amount'        => 0,
                'quantity'      => 0,
                'in_bi_id'      => null,
                'in_info_1_id'  => null,
                'in_info_2_id'  => null,
                'in_info_3_id'  => null,
                'in_quantity'   => 0,
                'out_bi_id'     => null,
                'out_info_1_id' => null,
                'out_info_2_id' => null,
                'out_info_3_id' => null,
                'out_quantity'  => 0,
                'source'        => 'document',
                'table_name'    => null,
                'table_id'      => null,
                'content'       => null,
                'note'          => null,
                'created_at'    => $now,
                'updated_at'    => $now,
            ];

            $rows = array_map(function ($op) use ($baseRow, $now) {
                $merged = array_merge($baseRow, $op);
                // Приводим дату к строке
                if ($merged['date'] instanceof \Carbon\Carbon) {
                    $merged['date'] = $merged['date']->format('Y-m-d H:i:s');
                } else {
                    $merged['date'] = (string) $merged['date'];
                }
                $merged['created_at'] = $now;
                $merged['updated_at'] = $now;
                return $merged;
            }, $operations);

            DB::connection($conn)->table('operations')->insert($rows);
        });
    }

    /**
     * Отменить проведение:
     * - Удалить операции
     * - status = draft (документ возвращается в редактируемый черновик)
     */
    public static function cancel(Document $document): void
    {
        $conn = $document->getConnectionName();

        DB::connection($conn)->transaction(function () use ($document, $conn) {
            DB::connection($conn)
                ->table('operations')
                ->where('table_name', 'documents')
                ->where('table_id', (string) $document->id)
                ->delete();

            $document->status = 'draft';
            $document->save();
        });
    }

    /**
     * Удалить документ:
     * - Удалить операции (hard delete)
     * - Удалить строки
     * - Soft delete документа
     */
    public static function delete(Document $document): void
    {
        $conn = $document->getConnectionName();

        DB::connection($conn)->transaction(function () use ($document, $conn) {
            DB::connection($conn)
                ->table('operations')
                ->where('table_name', 'documents')
                ->where('table_id', (string) $document->id)
                ->delete();

            DB::connection($conn)
                ->table('document_items')
                ->where('document_id', $document->id)
                ->delete();

            $document->delete(); // soft delete
        });
    }
}
