<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\HealthController;
use App\Http\Controllers\Api\V1\OperationsController;
use App\Http\Controllers\Api\V1\BalanceItemsController;
use App\Http\Controllers\Api\V1\BalanceSheetController;
use App\Http\Controllers\Api\V1\InfoController;

Route::prefix('v1')->group(function () {
    Route::get('/health',    HealthController::class);
    Route::post('/register', [AuthController::class, 'register']);
    Route::post('/login',    [AuthController::class, 'login']);
    Route::get('/me',        [AuthController::class, 'me']);
    Route::post('/logout',   [AuthController::class, 'logout']);

    Route::get('/operations',         [OperationsController::class, 'index']);
    Route::post('/operations',        [OperationsController::class, 'store']);
    Route::put('/operations/{id}',    [OperationsController::class, 'update']);
    Route::delete('/operations/{id}', [OperationsController::class, 'destroy']);

    Route::get('/balance-items',      [BalanceItemsController::class, 'index']);
    Route::get('/balance-sheet',      [BalanceSheetController::class, 'index']);

    Route::get('/info',               [InfoController::class, 'index']);
    Route::post('/info',              [InfoController::class, 'store']);
    Route::put('/info/{id}',          [InfoController::class, 'update']);
    Route::delete('/info/{id}',       [InfoController::class, 'destroy']);
});
