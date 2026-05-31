<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Builder;

class CategoryPosting extends Model
{
    protected $table = 'category_postings';

    protected $fillable = [
        'category',
        'counter_account_code',
        'flow_info_id',
        'partner_mode',
        'is_active',
    ];

    protected $casts = [
        'is_active'    => 'boolean',
        'flow_info_id' => 'integer',
    ];

    public function scopeActive(Builder $query): Builder
    {
        return $query->where('is_active', true);
    }
}
