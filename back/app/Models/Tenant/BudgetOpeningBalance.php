<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;

class BudgetOpeningBalance extends Model
{
    protected $table = 'budget_opening_balances';

    protected $fillable = [
        'budget_document_id',
        'cash_id',
        'amount',
        'is_manual',
    ];

    protected $casts = [
        'amount'    => 'decimal:2',
        'is_manual' => 'boolean',
    ];

    public function document()
    {
        return $this->belongsTo(BudgetDocument::class, 'budget_document_id');
    }
}
