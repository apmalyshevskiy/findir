<?php

namespace App\Services\Documents;

use App\Models\Tenant\Document;
use Illuminate\Support\Facades\DB;

/**
 * Расходная накладная — outgoing_invoice
 *
 * Шапка:
 *   bi_id          = А405 Клиенты
 *   info_1_id      = Покупатель (partner)
 *   revenue_bi_id  = П587 Доходы     ← скопировано из project при создании
 *   cogs_bi_id     = П588 Себестоимость ← скопировано из project при создании
 *   revenue_item_id = Статья дохода  ← скопировано из project при создании
 *
 * Строка:
 *   bi_id     = А200 Товары / А240 Продукты
 *   info_1_id = Номенклатура (product)
 *   info_2_id = Склад (department) — только если у счёта есть info_2_type
 *   amount      = сумма продажи (выручка)
 *   amount_cost = себестоимость
 *
 * Проводки на каждую строку (2 операции):
 *
 * Операция №1 — Выручка (на сумму item.amount):
 *   Дт  doc.bi_id (А405)      + doc.info_1_id (покупатель)
 *   Кт  doc.revenue_bi_id (П587)
 *       info_1 = doc.revenue_item_id  (статья дохода,  П587.info_1_type = revenue)
 *       info_2 = item.info_1_id       (номенклатура,   П587.info_2_type = product)
 *
 * Операция №2 — Себестоимость (на сумму item.amount_cost, если > 0):
 *   Дт  doc.cogs_bi_id (П588)
 *       info_1 = doc.revenue_item_id  (статья дохода,  П588.info_1_type = revenue)
 *       info_2 = item.info_1_id       (номенклатура,   П588.info_2_type = product)
 *   Кт  item.bi_id (А200/А240)
 *       info_1 = item.info_1_id  (номенклатура)
 *       info_2 = item.info_2_id  (склад, если А200)
 */
class OutgoingInvoiceStrategy implements DocumentStrategyInterface
{
    public function buildOperations(Document $document): array
    {
        $document->loadMissing('items');

        // Счета берём из документа (зафиксированы при создании).
        // Если не заполнены — операция этого типа не создаётся.
        $revenueBiId = $document->revenue_bi_id;
        $cogsBiId    = $document->cogs_bi_id;

        $operations = [];
        $content     = $this->buildContent($document);

        foreach ($document->items as $item) {
            $itemContent = $item->content ?? $content;

            // ── Операция №1: Выручка ──────────────────────────────
            // Создаём всегда если есть счёт доходов
            if ($revenueBiId) {
                $operations[] = [
                    'date'       => $document->date,
                    'project_id' => $document->project_id,
                    'amount'     => $item->amount,
                    'quantity'   => $item->quantity,

                    // Дт — покупатель (из шапки)
                    'in_bi_id'     => $document->bi_id,
                    'in_info_1_id' => $document->info_1_id, // покупатель
                    'in_info_2_id' => null,
                    'in_info_3_id' => null,
                    'in_quantity'  => $item->quantity,

                    // Кт — П587 Доходы
                    // info_1 = статья дохода (П587.info_1_type = revenue)
                    // info_2 = номенклатура  (П587.info_2_type = product)
                    'out_bi_id'     => $revenueBiId,
                    'out_info_1_id' => $document->revenue_item_id, // статья дохода
                    'out_info_2_id' => $item->info_1_id,           // номенклатура
                    'out_info_3_id' => null,
                    'out_quantity'  => 0,

                    'source'     => 'document',
                    'table_name' => 'documents',
                    'table_id'   => (string) $document->id,
                    'content'    => $itemContent,
                    'note'       => $item->note,
                ];
            }

            // ── Операция №2: Себестоимость ────────────────────────
            // Создаём только если заполнены счёт себестоимости и сумма
            if ($cogsBiId && $item->amount_cost && $item->amount_cost > 0) {
                $operations[] = [
                    'date'       => $document->date,
                    'project_id' => $document->project_id,
                    'amount'     => $item->amount_cost,
                    'quantity'   => $item->quantity,

                    // Дт — П588 Себестоимость
                    // info_1 = статья дохода (П588.info_1_type = revenue) — как у П587
                    // info_2 = номенклатура  (П588.info_2_type = product) — как у П587
                    'in_bi_id'     => $cogsBiId,
                    'in_info_1_id' => $document->revenue_item_id, // статья дохода
                    'in_info_2_id' => $item->info_1_id,           // номенклатура
                    'in_info_3_id' => null,
                    'in_quantity'  => $item->quantity,

                    // Кт — товар/продукт списывается со склада (из строки)
                    'out_bi_id'     => $item->bi_id,
                    'out_info_1_id' => $item->info_1_id, // номенклатура
                    'out_info_2_id' => $item->info_2_id, // склад (если А200)
                    'out_info_3_id' => $item->info_3_id,
                    'out_quantity'  => $item->quantity,

                    'source'     => 'document',
                    'table_name' => 'documents',
                    'table_id'   => (string) $document->id,
                    'content'    => 'Себестоимость: ' . $itemContent,
                    'note'       => $item->note,
                ];
            }
        }

        return $operations;
    }

    public function buildContent(Document $document): string
    {
        $document->loadMissing('info1');
        $parts = ['Реализация'];
        if ($document->info1) {
            $parts[] = $document->info1->name;
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
