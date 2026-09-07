<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;

class IntegrationLink extends Model
{
    protected $table = 'integration_links';

    /**
     * Таблица хранит два разных вида строк, они различаются по `entity`:
     * след загруженного объекта (fingerprint, synced_at) и соответствие,
     * заданное человеком до загрузки. У соответствия `local_id` может быть
     * пустым — это «не переносить».
     */
    protected $fillable = [
        'integration_id', 'entity', 'external_id', 'external_name',
        'local_type', 'local_id', 'fingerprint', 'synced_at',
    ];

    protected $casts = [
        'synced_at' => 'datetime',
    ];
}
