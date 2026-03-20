<?php

namespace App\Services\Documents;

use App\Models\Tenant\Document;

/**
 * Приходная накладная — incoming_invoice
 *
 * Шапка:
 *   bi_id     = П100 Поставщики
 *   info_1_id = Поставщик (partner)
 *
 * Строка:
 *   bi_id     = А200 Товары / А230 Материалы
 *   info_1_id = Номенклатура (product)
 *   info_2_id = Склад (department) — только если у счёта есть info_2_type
 *
 * Проводка на каждую строку (1 операция):
 *   Дт  item.bi_id + item.info_1_id (номенклатура) + item.info_2_id (склад)
 *   Кт  doc.bi_id  + doc.info_1_id  (поставщик)
 */
class IncomingInvoiceStrategy implements DocumentStrategyInterface
{
    public function buildOperations(Document $document): array
    {
        $document->loadMissing('items');
        $operations = [];
        $content    = $this->buildContent($document);

        foreach ($document->items as $item) {
            $operations[] = [
                'date'       => $document->date,
                'project_id' => $document->project_id,
                'amount'     => $item->amount,
                'quantity'   => $item->quantity,

                // Дт — строка (товар/материал поступает на склад)
                'in_bi_id'     => $item->bi_id,
                'in_info_1_id' => $item->info_1_id,  // номенклатура
                'in_info_2_id' => $item->info_2_id,  // склад (если А200)
                'in_info_3_id' => $item->info_3_id,
                'in_quantity'  => $item->quantity,

                // Кт — шапка (задолженность перед поставщиком)
                'out_bi_id'     => $document->bi_id,
                'out_info_1_id' => $document->info_1_id, // поставщик
                'out_info_2_id' => $document->info_2_id,
                'out_info_3_id' => $document->info_3_id,
                'out_quantity'  => 0,

                'source'     => 'document',
                'table_name' => 'documents',
                'table_id'   => (string) $document->id,
                'content'    => $item->content ?? $content,
                'note'       => $item->note,
            ];
        }

        return $operations;
    }

    public function buildContent(Document $document): string
    {
        $document->loadMissing('info1');
        $parts = ['Поступление'];
        if ($document->info1) {
            $parts[] = 'от ' . $document->info1->name;
        }
        if ($document->number) {
            $parts[] = '№' . $document->number;
        }
        if ($document->date) {
            $parts[] = 'от ' . $document->date->format('d.m.Y');
        }
        return implode(' ', $parts);
    }
}
