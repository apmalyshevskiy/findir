<?php

namespace App\Models\Tenant;

use App\Services\History\HasHistory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Database\Eloquent\Builder;

class Info extends Model
{
    use SoftDeletes;
    use HasHistory;

    protected $table = 'info';

    public function historyEntity(): string
    {
        return 'info';
    }

    protected $fillable = [
        'name', 'type', 'code', 'description',
        'inn',
        'default_expense_id',
        'parent_id', 'sort_order', 'is_active',
        'expense_kind', 'flow_kind',
    ];

    /**
     * Виды статьи расхода. По ним БДР раскладывает расходы на группы и считает
     * промежуточные прибыли. У остальных типов справочника смысла не имеют.
     */
    public const EXPENSE_KINDS = ['fixed', 'variable', 'investment'];

    /**
     * Виды деятельности у статьи ДДС — разделы ОДДС. Порядок тот, в котором
     * разделы идут в отчёте: сначала основная работа, потом вложения, потом
     * привлечение и возврат денег.
     */
    public const FLOW_KINDS = ['operating', 'investing', 'financing'];

    protected $casts = [
        'is_active' => 'boolean',
        'default_expense_id' => 'integer',
    ];

    public function scopeActive(Builder $query): Builder
    {
        return $query->where('is_active', true);
    }

    public function scopeOfType(Builder $query, string $type): Builder
    {
        return $query->where('type', $type);
    }
}
