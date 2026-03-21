<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Documents\CostCalculatorService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * POST /api/v1/documents/calculate-cost
 *
 * Рассчитывает себестоимость для набора строк документа.
 * Используется фронтом при нажатии кнопки «Рассчитать себестоимость»
 * или автоматически при выборе номенклатуры.
 *
 * Запрос:
 * {
 *   "date":       "2026-03-21T15:00",
 *   "project_id": 1,
 *   "items": [
 *     { "bi_id": 200, "info_1_id": 5, "info_2_id": 3, "info_3_id": null, "quantity": 3 }
 *   ]
 * }
 *
 * Ответ:
 * {
 *   "data": [
 *     {
 *       "bi_id": 200, "info_1_id": 5, "info_2_id": 3, "info_3_id": null,
 *       "quantity": 3,
 *       "stock_amount": 54000,
 *       "stock_quantity": 10,
 *       "unit_cost": 5400,
 *       "amount_cost": 16200,
 *       "negative_stock": false
 *     }
 *   ],
 *   "has_warnings": false
 * }
 */
class CostController extends TenantController
{
    public function calculate(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate([
            'date'               => 'required|date',
            'project_id'         => 'required|integer',
            'items'              => 'required|array|min:1',
            'items.*.bi_id'      => 'required|integer',
            'items.*.info_1_id'  => 'nullable|integer',
            'items.*.info_2_id'  => 'nullable|integer',
            'items.*.info_3_id'  => 'nullable|integer',
            'items.*.quantity'   => 'required|numeric|min:0',
        ]);

        $results = CostCalculatorService::calculate(
            $this->dbName,
            $data['date'],
            (int) $data['project_id'],
            $data['items']
        );

        $hasWarnings = collect($results)->contains('negative_stock', true);

        return response()->json([
            'data'         => $results,
            'has_warnings' => $hasWarnings,
        ]);
    }
}
