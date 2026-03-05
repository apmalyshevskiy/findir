<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class BalanceItem extends Model
{
    use SoftDeletes;

    protected $table = 'balance_items';

    protected $fillable = [
        'code', 'name', 'type', 'info_1_type', 'info_2_type', 'info_3_type',
        'description',
    ];
}
