<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BalanceItem;
use Illuminate\Http\Request;

class BalanceItemsController extends TenantController
{
    public function index(Request $request)
    {
        $this->initTenant($request);

        $items = (new BalanceItem)
            ->setConnection($this->dbName)
            ->newQuery()
            ->orderBy('code')
            ->get();

        return response()->json(['data' => $items]);
    }
}
