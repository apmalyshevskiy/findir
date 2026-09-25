<?php

namespace App\Models\Tenant;

use App\Services\History\HasHistory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Operation extends Model
{
    use SoftDeletes;
    use HasHistory;

    protected $table = 'operations';

    public function historyEntity(): string
    {
        return 'operation';
    }

    protected $fillable = [
    'date', 'project_id', 'amount', 'quantity',
    // Количество ведётся по сторонам: в дебетовую строку идёт in_quantity,
    // в кредитовую — out_quantity. Общая колонка quantity осталась от
    // первой схемы, триггер её больше не читает
    'in_quantity', 'out_quantity',
    'in_bi_id', 'out_bi_id',
    'in_info_1_id', 'in_info_2_id', 'in_info_3_id',
    'out_info_1_id', 'out_info_2_id', 'out_info_3_id',
    'note', 'content', 'source', 'is_posted',
    'external_id', 'external_date',
    // Заполняется контроллером из токена, не из тела запроса
    'created_by',
];
    protected $casts = [
        'date'          => 'datetime',
        'external_date' => 'date',
        'amount'        => 'float',
        'is_posted'     => 'boolean',
    ];

    /** Создана проведением документа — правится только через него. */
    public function fromDocument(): bool
    {
        return $this->table_name === 'documents' && $this->table_id;
    }

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

    // Третий слот долго никому не был нужен и связи не имел. Понадобился,
    // когда разрез отчёта стал настраиваемым: отдел вполне может стоять в нём
    public function inInfo3()
    {
        return $this->belongsTo(Info::class, 'in_info_3_id');
    }

    public function outInfo3()
    {
        return $this->belongsTo(Info::class, 'out_info_3_id');
    }
}
