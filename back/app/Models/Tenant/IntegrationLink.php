<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;

class IntegrationLink extends Model
{
    protected $table = 'integration_links';

    protected $fillable = [
        'integration_id', 'entity', 'external_id',
        'local_type', 'local_id', 'fingerprint', 'synced_at',
    ];

    protected $casts = [
        'synced_at' => 'datetime',
    ];
}
