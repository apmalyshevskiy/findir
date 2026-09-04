<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Вид документа: что становится шапкой, что строками и куда это проводится.
 *
 * Заводится в справочнике, а не в коде — см. DocumentTypesSeeder.
 */
class DocumentType extends Model
{
    protected $table = 'document_types';

    protected $fillable = [
        'code', 'name',
        'head_bi_id', 'head_side', 'item_bi_id',
        'show_quantity', 'show_price', 'show_vat', 'line_head_fields',
        'engine', 'is_system', 'is_active', 'sort_order',
    ];

    protected $casts = [
        'show_quantity'    => 'boolean',
        'show_price'       => 'boolean',
        'show_vat'         => 'boolean',
        'is_system'        => 'boolean',
        'is_active'        => 'boolean',
        // Какие поля корреспондирующей стороны вид выносит в строку колонкой:
        // ["bi", "info_1", "info_2", "info_3"]
        'line_head_fields' => 'array',
    ];

    public function headBalanceItem(): BelongsTo
    {
        return $this->belongsTo(BalanceItem::class, 'head_bi_id');
    }

    public function itemBalanceItem(): BelongsTo
    {
        return $this->belongsTo(BalanceItem::class, 'item_bi_id');
    }

    /** Шапка идёт в дебет, строки — в кредит */
    public function headIsDebit(): bool
    {
        return $this->head_side === 'debit';
    }
}
