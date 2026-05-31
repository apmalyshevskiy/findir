<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Builder;

class PaymentClassificationRule extends Model
{
    protected $table = 'payment_classification_rules';

    protected $fillable = [
        'direction',
        'inn',
        'purpose_keywords',
        'has_kbk',
        'amount_min',
        'amount_max',
        'category',
        'priority',
        'source',
        'is_active',
    ];

    protected $casts = [
        'has_kbk'         => 'boolean',
        'is_active'       => 'boolean',
        'amount_min'      => 'decimal:2',
        'amount_max'      => 'decimal:2',
        'priority'        => 'integer',
        'hit_count'       => 'integer',
        'last_applied_at' => 'datetime',
    ];

    public function scopeActive(Builder $query): Builder
    {
        return $query->where('is_active', true);
    }
}
