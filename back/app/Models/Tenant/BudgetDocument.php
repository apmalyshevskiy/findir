<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class BudgetDocument extends Model
{
    use SoftDeletes;

    protected $table = 'budget_documents';

    protected $fillable = [
        'name',
        'type',
        'period_from',
        'period_to',
        'project_id',
        'status',
        'created_by',
    ];

    protected $casts = [
        'period_from' => 'date',
        'period_to'   => 'date',
    ];

    public function items()
    {
        return $this->hasMany(BudgetItem::class, 'budget_document_id');
    }

    public function openingBalances()
    {
        return $this->hasMany(BudgetOpeningBalance::class, 'budget_document_id');
    }
}
