<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ProjectsController extends TenantController
{
    public function index(Request $request)
    {
        $this->initTenant($request);

        $projects = DB::connection($this->dbName)
            ->table('projects')
            ->whereNull('deleted_at')
            ->orderBy('name')
            ->select('id', 'name', 'currency')
            ->get();

        return response()->json(['data' => $projects]);
    }
}
