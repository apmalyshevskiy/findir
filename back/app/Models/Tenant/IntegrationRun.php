<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;

class IntegrationRun extends Model
{
    protected $table = 'integration_runs';

    protected $fillable = [
        'integration_id', 'entity', 'mode', 'period_from', 'period_to', 'status',
        'fetched', 'created', 'updated', 'skipped', 'failed',
        'message', 'details', 'started_at', 'finished_at',
    ];

    protected $casts = [
        'details'     => 'array',
        'period_from' => 'date',
        'period_to'   => 'date',
        'started_at'  => 'datetime',
        'finished_at' => 'datetime',
    ];
}
