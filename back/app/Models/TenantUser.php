<?php

namespace App\Models;

use Illuminate\Foundation\Auth\User as Authenticatable;
use Laravel\Sanctum\HasApiTokens;

class TenantUser extends Authenticatable
{
    use HasApiTokens;

    protected $guarded = [];
    protected $hidden  = ['password'];

    public string $tenant_id = '';
}
