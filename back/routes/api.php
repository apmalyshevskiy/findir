<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\HealthController;
use App\Http\Controllers\Api\V1\OperationsController;
use App\Http\Controllers\Api\V1\BalanceItemsController;
use App\Http\Controllers\Api\V1\BalanceSheetController;
use App\Http\Controllers\Api\V1\InfoController;
use App\Http\Controllers\Api\V1\BankStatementController;
use App\Http\Controllers\Api\V1\ProjectsController;
use App\Http\Controllers\Api\V1\DocumentsController;
use App\Http\Controllers\Api\V1\CostController;
use App\Http\Controllers\Api\V1\BudgetController;

Route::prefix('v1')->group(function () {
    Route::get('/health',    HealthController::class);
    Route::post('/register', [AuthController::class, 'register']);
    Route::post('/login',    [AuthController::class, 'login']);
    Route::get('/me',        [AuthController::class, 'me']);
    Route::post('/logout',   [AuthController::class, 'logout']);

    // Проверка домена при регистрации (публичные)
    Route::get('/check-domain',   [AuthController::class, 'checkDomain']);
    Route::get('/suggest-domain', [AuthController::class, 'suggestDomain']);

    // Операции
    Route::get('/operations',         [OperationsController::class, 'index']);
    Route::post('/operations',        [OperationsController::class, 'store']);
    Route::put('/operations/{id}',    [OperationsController::class, 'update']);
    Route::delete('/operations/{id}', [OperationsController::class, 'destroy']);

    // Банковская выписка
    Route::post('/bank-statements/parse', [BankStatementController::class, 'parse']);

    // Справочники
    Route::get('/projects',           [ProjectsController::class, 'index']);
    Route::get('/balance-items',      [BalanceItemsController::class, 'index']);
    Route::get('/balance-sheet',      [BalanceSheetController::class, 'index']);

    Route::get('/info',               [InfoController::class, 'index']);
    Route::post('/info',              [InfoController::class, 'store']);
    Route::put('/info/{id}',          [InfoController::class, 'update']);
    Route::delete('/info/{id}',       [InfoController::class, 'destroy']);

    // Документы — статические маршруты ПЕРЕД динамическими {id}
    Route::get('/documents',                   [DocumentsController::class, 'index']);
    Route::post('/documents',                  [DocumentsController::class, 'store']);
    Route::post('/documents/calculate-cost',   [CostController::class, 'calculate']);

    Route::get('/documents/{id}',              [DocumentsController::class, 'show']);
    Route::put('/documents/{id}',              [DocumentsController::class, 'update']);
    Route::delete('/documents/{id}',           [DocumentsController::class, 'destroy']);
    Route::post('/documents/{id}/post',        [DocumentsController::class, 'post']);
    Route::post('/documents/{id}/cancel',      [DocumentsController::class, 'cancel']);

    // Бюджетирование
    Route::get('/budget-documents',          [BudgetController::class, 'index']);
    Route::post('/budget-documents',         [BudgetController::class, 'store']);
    Route::put('/budget-documents/{id}',     [BudgetController::class, 'update']);
    Route::delete('/budget-documents/{id}',  [BudgetController::class, 'destroy']);
    Route::get('/budget-report/{id}',        [BudgetController::class, 'report']);
    Route::post('/budget-items',              [BudgetController::class, 'storeItem']);
    Route::put('/budget-items/{id}',          [BudgetController::class, 'updateItem']);
    Route::delete('/budget-items/{id}',       [BudgetController::class, 'destroyItem']);
    Route::put('/budget-opening-balances/upsert', [BudgetController::class, 'upsertOpeningBalance']);
});
