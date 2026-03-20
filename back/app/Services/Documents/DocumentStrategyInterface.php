<?php

namespace App\Services\Documents;

use App\Models\Tenant\Document;

interface DocumentStrategyInterface
{
    /**
     * Сгенерировать массив данных для вставки в operations.
     * Каждый элемент массива — одна операция.
     */
    public function buildOperations(Document $document): array;

    /**
     * Сформировать автоматический content шапки документа.
     */
    public function buildContent(Document $document): string;
}
