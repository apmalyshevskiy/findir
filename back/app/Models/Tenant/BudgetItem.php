<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;

class BudgetItem extends Model
{
    protected $table = 'budget_items';

    protected $fillable = [
        'budget_document_id',
        'article_id',
        'section',       // 'revenue' | 'cost' | 'expenses' для БДР, null для ДДС
        'cash_id',
        'period_date',
        'content',
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
