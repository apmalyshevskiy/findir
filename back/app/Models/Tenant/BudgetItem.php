<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;

class BudgetItem extends Model
{
    protected $table = 'budget_items';

    protected $fillable = [
        'budget_document_id',
        'article_id',
        'cash_id',
        'period_date',
        'amount',
    ];

    protected $casts = [
        'amount'      => 'decimal:2',
        'period_date' => 'date',
    ];

    public function document()
    {
        return $this->belongsTo(BudgetDocument::class, 'budget_document_id');
    }

    public function article()
    {
        return $this->belongsTo(Info::class, 'article_id');
    }
}
