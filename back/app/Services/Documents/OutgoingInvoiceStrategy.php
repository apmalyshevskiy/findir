<?php

namespace App\Services\Documents;

use App\Models\Tenant\Document;
use App\Services\Documents\CostCalculatorService;
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

        $revenueBiId = $document->revenue_bi_id;
        $cogsBiId    = $document->cogs_bi_id;

        $operations = [];
        $content    = $this->buildContent($document);

        // ── Пересчёт себестоимости при проведении ─────────────────────────────
        // Если у строки нет amount_cost или он 0 — рассчитываем автоматически.
        // Если уже заполнен вручную — оставляем как есть (уважаем ручной ввод).
        if ($cogsBiId && $document->items->isNotEmpty()) {
            $itemsForCalc = $document->items
                ->filter(fn($i) => !$i->amount_cost || $i->amount_cost <= 0)
                ->map(fn($i) => [
                    'bi_id'     => $i->bi_id,
                    'info_1_id' => $i->info_1_id,
                    'info_2_id' => $i->info_2_id,
                    'info_3_id' => $i->info_3_id,
                    'quantity'  => $i->quantity,
                    '_item_id'  => $i->id,
                ])->values()->toArray();

            if (!empty($itemsForCalc)) {
                $costs = CostCalculatorService::calculate(
                    $document->getConnectionName(),
                    $document->date->format('Y-m-d H:i:s'),
                    $document->project_id,
                    $itemsForCalc
                );

                // Индексируем по item_id для быстрого поиска
                $costByItemId = [];
                foreach ($itemsForCalc as $idx => $calcItem) {
                    if (isset($costs[$idx])) {
                        $costByItemId[$calcItem['_item_id']] = $costs[$idx];
                    }
                }

                // Обновляем amount_cost прямо в БД (до создания операций)
                foreach ($document->items as $item) {
                    if (isset($costByItemId[$item->id])) {
                        $item->amount_cost = $costByItemId[$item->id]['amount_cost'];
                        $item->save();
                    }
                }

                // Перезагружаем строки с обновлёнными значениями
                $document->load('items');
            }
        }

        foreach ($document->items as $item) {
            $itemContent = $item->content ?? $content;
            $qty         = (float) ($item->quantity ?? 0);

            // ── Операция №1: Выручка ──────────────────────────────
            // Создаём всегда если есть счёт доходов
            if ($revenueBiId) {
                $operations[] = [
                    'date'       => $document->date,
                    'project_id' => $document->project_id,
                    'amount'     => (float) $item->amount,
                    'quantity'   => $qty,

                    'in_bi_id'     => $document->bi_id,
                    'in_info_1_id' => $document->info_1_id,
                    'in_info_2_id' => null,
                    'in_info_3_id' => null,
                    'in_quantity'  => $qty,

                    'out_bi_id'     => $revenueBiId,
                    'out_info_1_id' => $document->revenue_item_id,
                    'out_info_2_id' => $item->info_1_id,
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
                    'amount'     => (float) $item->amount_cost,
                    'quantity'   => $qty,

                    'in_bi_id'     => $cogsBiId,
                    'in_info_1_id' => $document->revenue_item_id,
                    'in_info_2_id' => $item->info_1_id,
                    'in_info_3_id' => null,
                    'in_quantity'  => $qty,

                    'out_bi_id'     => $item->bi_id,
                    'out_info_1_id' => $item->info_1_id,
                    'out_info_2_id' => $item->info_2_id,
                    'out_info_3_id' => $item->info_3_id,
                    'out_quantity'  => $qty,

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
