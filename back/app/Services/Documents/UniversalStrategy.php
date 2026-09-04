<?php

namespace App\Services\Documents;

use App\Models\Tenant\BalanceItem;
use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentType;

/**
 * Универсальное проведение: шапка против строк.
 *
 * Из каждой строки документа получается одна операция. Счёт и аналитика шапки
 * идут в сторону, заданную видом документа, счёт и аналитика строки — в
 * противоположную:
 *
 *   Приходная накладная  шапка П100 в Кт → Дт А200 Товары   / Кт П100 Поставщик
 *   Начисление ЗП        шапка П589 в Дт → Дт П589 Расходы  / Кт П335 Сотрудник
 *   Авансовый отчёт      шапка А100 в Кт → Дт П589 Расходы  / Кт А100 Касса
 *
 * Строка может переопределить корреспондирующую сторону — и аналитику, и сам
 * счёт. Пусто в строке означает «как в шапке». Ради этого всё и затевалось: в
 * авансовом отчёте касса одна на документ, а статья ДДС у каждой строки своя.
 */
class UniversalStrategy implements DocumentStrategyInterface
{
    public function __construct(private DocumentType $type) {}

    public function buildOperations(Document $document): array
    {
        $document->loadMissing('items');
        $content    = $this->buildContent($document);
        $headIsDebit = $this->type->headIsDebit();

        // Количество пишем только той стороне, чей счёт его ведёт. Триггер и сам
        // отбрасывает лишнее, но хранить количество на счёте без количественного
        // учёта — значит показывать его в форме операции там, где его нет
        $quantityAccounts = $this->quantityAccounts($document);

        $operations = [];

        foreach ($document->items as $item) {
            $line = [
                'bi_id'     => $item->bi_id,
                'info_1_id' => $item->info_1_id,
                'info_2_id' => $item->info_2_id,
                'info_3_id' => $item->info_3_id,
            ];

            $head = $this->headFor($document, $item);

            $debit  = $headIsDebit ? $head : $line;
            $credit = $headIsDebit ? $line : $head;
            $qty    = (float) ($item->quantity ?? 0);

            $operations[] = [
                'date'       => $document->date,
                'project_id' => $document->project_id,
                'amount'     => (float) $item->amount,
                'quantity'   => $qty,

                'in_bi_id'     => $debit['bi_id'],
                'in_info_1_id' => $debit['info_1_id'],
                'in_info_2_id' => $debit['info_2_id'],
                'in_info_3_id' => $debit['info_3_id'],
                'in_quantity'  => in_array($debit['bi_id'], $quantityAccounts) ? $qty : 0,

                'out_bi_id'     => $credit['bi_id'],
                'out_info_1_id' => $credit['info_1_id'],
                'out_info_2_id' => $credit['info_2_id'],
                'out_info_3_id' => $credit['info_3_id'],
                'out_quantity'  => in_array($credit['bi_id'], $quantityAccounts) ? $qty : 0,

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

        $parts = [$this->type->name];

        if ($document->number) {
            $parts[] = '№' . $document->number;
        }
        if ($document->date) {
            $parts[] = 'от ' . $document->date->format('d.m.Y');
        }
        // Аналитика шапки — обычно контрагент или сотрудник: именно она отвечает
        // на вопрос «с кем», когда операция попадает в расшифровку отчёта
        if ($document->info1) {
            $parts[] = '— ' . $document->info1->name;
        }

        return implode(' ', $parts);
    }

    /**
     * Корреспондирующая сторона для строки.
     *
     * Пока строка стоит на счёте шапки, аналитика добирается из шапки по каждому
     * слоту отдельно: в авансовом отчёте касса приезжает из шапки, а статья ДДС
     * своя у каждой траты.
     *
     * Но если строка увела корреспонденцию на другой счёт, аналитику шапки не
     * наследуем вовсе: слоты у чужого счёта означают другое, и касса из шапки
     * записалась бы в поле сотрудника. Такая строка описывает свою сторону
     * целиком — это видно и в форме, где поля аналитики перерисовываются под
     * выбранный в строке счёт.
     */
    private function headFor(Document $document, $item): array
    {
        $ownAccount = $item->head_bi_id && $item->head_bi_id != $document->bi_id;

        return [
            'bi_id'     => $item->head_bi_id ?: $document->bi_id,
            'info_1_id' => $ownAccount ? $item->head_info_1_id : ($item->head_info_1_id ?: $document->info_1_id),
            'info_2_id' => $ownAccount ? $item->head_info_2_id : ($item->head_info_2_id ?: $document->info_2_id),
            'info_3_id' => $ownAccount ? $item->head_info_3_id : ($item->head_info_3_id ?: $document->info_3_id),
        ];
    }

    /** Идентификаторы счетов документа, которые ведут количественный учёт */
    private function quantityAccounts(Document $document): array
    {
        $ids = $document->items->pluck('bi_id')
            ->merge($document->items->pluck('head_bi_id'))
            ->push($document->bi_id)
            ->unique()->filter();

        if ($ids->isEmpty()) {
            return [];
        }

        return (new BalanceItem)->setConnection($document->getConnectionName())
            ->newQuery()
            ->whereIn('id', $ids)
            ->where('has_quantity', true)
            ->pluck('id')
            ->all();
    }
}
