<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Info extends Model
{
    use SoftDeletes;

    protected $table = 'info';

    protected $fillable = [
        'name', 'type', 'code', 'description', 'parent_id', 'is_active',
    ];

    protected $casts = [
        'is_active' => 'boolean',
    ];

    public function scopeActive($query)
    {
        return $query->where('is_active', 1);
    }

    public function scopeOfType($query, string $type)
    {
        return $query->where('type', $type);
    }

    public function parent()
    {
        return $this->belongsTo(Info::class, 'parent_id');
    }

    public function children()
    {
        return $this->hasMany(Info::class, 'parent_id');
    }
}
