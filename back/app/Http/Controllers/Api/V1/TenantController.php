<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Services\TenantService;
use Illuminate\Http\Request;

abstract class TenantController extends Controller
{
    protected string $tenantId;
    protected string $dbName;

    protected function initTenant(Request $request): void
    {
        $this->tenantId = TenantService::tenantIdFromRequest($request);
        $this->dbName   = TenantService::connect($this->tenantId);
    }
}
