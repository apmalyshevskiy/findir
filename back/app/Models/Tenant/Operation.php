<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Operation extends Model
{
    use SoftDeletes;

    protected $table = 'operations';

    protected $fillable = [
    'date', 'project_id', 'amount', 'quantity',
    'in_bi_id', 'out_bi_id',
    'in_info_1_id', 'in_info_2_id', 'in_info_3_id',
    'out_info_1_id', 'out_info_2_id', 'out_info_3_id',
    'note', 'content', 'source',
    'external_id', 'external_date',
];
    protected $casts = [
        'date'          => 'datetime',
        'external_date' => 'date',
        'amount'        => 'float',
    ];

    public function inBalanceItem()
    {
        return $this->belongsTo(BalanceItem::class, 'in_bi_id');
    }

    public function outBalanceItem()
    {
        return $this->belongsTo(BalanceItem::class, 'out_bi_id');
    }

    public function inInfo1()
    {
        return $this->belongsTo(Info::class, 'in_info_1_id');
    }

    public function inInfo2()
    {
        return $this->belongsTo(Info::class, 'in_info_2_id');
    }

    public function outInfo1()
    {
        return $this->belongsTo(Info::class, 'out_info_1_id');
    }

    public function outInfo2()
    {
        return $this->belongsTo(Info::class, 'out_info_2_id');
    }
}
