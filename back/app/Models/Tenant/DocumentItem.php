<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DocumentItem extends Model
{
    protected $table = 'document_items';

    protected $fillable = [
        'document_id', 'sort_order',
        'bi_id', 'info_1_id', 'info_2_id', 'info_3_id',
        'quantity', 'price', 'amount', 'amount_vat', 'amount_cost',
        'content', 'note',
    ];

    protected $casts = [
        'quantity'    => 'float',
        'price'       => 'float',
        'amount'      => 'float',
        'amount_vat'  => 'float',
        'amount_cost' => 'float',
    ];

    public function document(): BelongsTo
    {
        return $this->belongsTo(Document::class);
    }

    public function balanceItem(): BelongsTo
    {
        return $this->belongsTo(BalanceItem::class, 'bi_id');
    }

    public function info1(): BelongsTo
    {
        return $this->belongsTo(Info::class, 'info_1_id');
    }

    public function info2(): BelongsTo
    {
        return $this->belongsTo(Info::class, 'info_2_id');
    }

    public function info3(): BelongsTo
    {
        return $this->belongsTo(Info::class, 'info_3_id');
    }
}
