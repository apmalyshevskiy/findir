<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Document extends Model
{
    use SoftDeletes;

    protected $table = 'documents';

    protected $fillable = [
        'date', 'number', 'external_number', 'external_date',
        'project_id', 'type', 'status', 'created_by',
        // шапка
        'bi_id', 'info_1_id', 'info_2_id', 'info_3_id',
        // только outgoing_invoice — копируются из project при создании
        'revenue_bi_id', 'cogs_bi_id', 'revenue_item_id',
        // суммы
        'amount', 'amount_vat',
        // текст
        'content', 'note', 'extra',
    ];

    protected $casts = [
        'date'          => 'datetime',   // теперь datetime, не date
        'external_date' => 'date',
        'amount'        => 'float',
        'amount_vat'    => 'float',
        'extra'         => 'array',
    ];

    public function items(): HasMany
    {
        return $this->hasMany(DocumentItem::class)->orderBy('sort_order');
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

    public function revenueBalanceItem(): BelongsTo
    {
        return $this->belongsTo(BalanceItem::class, 'revenue_bi_id');
    }

    public function cogsBalanceItem(): BelongsTo
    {
        return $this->belongsTo(BalanceItem::class, 'cogs_bi_id');
    }

    public function revenueItem(): BelongsTo
    {
        return $this->belongsTo(Info::class, 'revenue_item_id');
    }

    public function createdByUser(): BelongsTo
    {
        return $this->belongsTo(\App\Models\TenantUser::class, 'created_by');
    }

    public function isPosted(): bool    { return $this->status === 'posted'; }
    public function isDraft(): bool     { return $this->status === 'draft'; }
    public function isCancelled(): bool { return $this->status === 'cancelled'; }
    public function isOutgoing(): bool  { return $this->type === 'outgoing_invoice'; }
    public function isIncoming(): bool  { return $this->type === 'incoming_invoice'; }
}
