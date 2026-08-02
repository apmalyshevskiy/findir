<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class BalanceItem extends Model
{
    use SoftDeletes;

    protected $table = 'balance_items';

    protected $fillable = [
        'parent_id', 'code', 'name',
        'info_1_type', 'info_1_turnover_only',
        'info_2_type', 'info_2_turnover_only',
        'info_3_type', 'info_3_turnover_only',
        'has_quantity', 'is_system',
    ];

    protected $casts = [
        'info_1_turnover_only' => 'boolean',
        'info_2_turnover_only' => 'boolean',
        'info_3_turnover_only' => 'boolean',
        'has_quantity'         => 'boolean',
        'is_system'            => 'boolean',
    ];
}
