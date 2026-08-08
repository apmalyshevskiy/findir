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
use App\Http\Controllers\Api\V1\PaymentClassificationRuleController;
use App\Http\Controllers\Api\V1\CategoryPostingController;
use App\Http\Controllers\Api\V1\SettingsController;
use App\Http\Controllers\Api\V1\DashboardController;
use App\Http\Controllers\Api\V1\FundsController;
use App\Http\Controllers\Api\V1\FundSchemeController;
use App\Http\Controllers\Api\V1\FundPlanDocController;
use App\Http\Controllers\Api\V1\AiController;
use App\Http\Controllers\Api\V1\OperationTemplatesController;
use App\Http\Controllers\Api\V1\DictionaryTemplatesController;
use App\Http\Controllers\Api\V1\BulkOperationsController;
use App\Http\Controllers\Api\V1\BackupController;
use App\Http\Controllers\Api\V1\IntegrationsController;

Route::prefix('v1')->group(function () {
    Route::get('/health',    HealthController::class);
    Route::post('/register', [AuthController::class, 'register']);
    Route::post('/login',    [AuthController::class, 'login']);
    Route::get('/me',        [AuthController::class, 'me']);
    Route::post('/logout',   [AuthController::class, 'logout']);

    // Проверка домена при регистрации (публичные)
    Route::get('/check-domain',   [AuthController::class, 'checkDomain']);
    Route::get('/suggest-domain', [AuthController::class, 'suggestDomain']);

    // Дашборд
    Route::get('/dashboard/summary',        [DashboardController::class, 'summary']);
    Route::get('/dashboard/metrics',        [DashboardController::class, 'metrics']);
    Route::get('/dashboard/revenue-series', [DashboardController::class, 'revenueSeries']);
    Route::get('/dashboard/layout',         [DashboardController::class, 'getLayout']);
    Route::put('/dashboard/layout',         [DashboardController::class, 'saveLayout']);

    // Массовая правка выбранных операций — до /operations/{id}
    Route::post('/operations/bulk-preview',          [BulkOperationsController::class, 'preview']);
    Route::post('/operations/bulk-update',           [BulkOperationsController::class, 'update']);
    Route::get ('/operations/bulk-log',              [BulkOperationsController::class, 'log']);
    Route::post('/operations/bulk-log/{id}/revert',  [BulkOperationsController::class, 'revert']);

    // Операции
    Route::get('/operations',         [OperationsController::class, 'index']);
    Route::post('/operations',        [OperationsController::class, 'store']);
    Route::put('/operations/{id}',    [OperationsController::class, 'update']);
    Route::delete('/operations/{id}', [OperationsController::class, 'destroy']);

    // Банковская выписка
    Route::post('/bank-statements/parse', [BankStatementController::class, 'parse']);

    // Справочники
    Route::get('/projects',           [ProjectsController::class, 'index']);
    Route::post('/projects',          [ProjectsController::class, 'store']);
    Route::put('/projects/{id}',      [ProjectsController::class, 'update']);
    Route::delete('/projects/{id}',   [ProjectsController::class, 'destroy']);
    Route::get('/balance-items',         [BalanceItemsController::class, 'index']);
    Route::post('/balance-items',        [BalanceItemsController::class, 'store']);
    Route::put('/balance-items/{id}',    [BalanceItemsController::class, 'update']);
    Route::delete('/balance-items/{id}', [BalanceItemsController::class, 'destroy']);
    Route::get('/balance-sheet',      [BalanceSheetController::class, 'index']);

    // Шаблоны наполнения справочников (кнопка «Заполнить»)
    Route::get('/dictionary-templates',              [DictionaryTemplatesController::class, 'index']);
    Route::get('/dictionary-templates/{key}',        [DictionaryTemplatesController::class, 'show']);
    Route::post('/dictionary-templates/{key}/apply', [DictionaryTemplatesController::class, 'apply']);

    Route::get('/info',               [InfoController::class, 'index']);
    Route::post('/info',              [InfoController::class, 'store']);
    Route::put('/info/{id}',          [InfoController::class, 'update']);
    Route::delete('/info/{id}',       [InfoController::class, 'destroy']);

    Route::get   ('/classification-rules',      [PaymentClassificationRuleController::class, 'index']);
    Route::post  ('/classification-rules',      [PaymentClassificationRuleController::class, 'store']);
    Route::put   ('/classification-rules/{id}', [PaymentClassificationRuleController::class, 'update']);
    Route::delete('/classification-rules/{id}', [PaymentClassificationRuleController::class, 'destroy']);

    Route::get   ('/category-postings',      [CategoryPostingController::class, 'index']);
    Route::post  ('/category-postings',      [CategoryPostingController::class, 'store']);
    Route::put   ('/category-postings/{id}', [CategoryPostingController::class, 'update']);
    Route::delete('/category-postings/{id}', [CategoryPostingController::class, 'destroy']);

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
    Route::get('/budget-items',               [BudgetController::class, 'indexItems']);
    Route::post('/budget-items',              [BudgetController::class, 'storeItem']);
    Route::put('/budget-items/{id}',          [BudgetController::class, 'updateItem']);
    Route::delete('/budget-items/{id}',       [BudgetController::class, 'destroyItem']);
    Route::put('/budget-opening-balances/upsert', [BudgetController::class, 'upsertOpeningBalance']);

    Route::get('/settings/acquiring-fee-rules',  [SettingsController::class, 'acquiringFeeRules']);
    Route::put('/settings/acquiring-fee-rules',  [SettingsController::class, 'updateAcquiringFeeRules']);

    // Интеграции с учётными системами.
    // /types и /dictionaries объявлены до /{id}, иначе Laravel примет слово
    // «types» за идентификатор и уронит поиск записи
    Route::get   ('/integrations/types',              [IntegrationsController::class, 'types']);
    Route::get   ('/integrations',                    [IntegrationsController::class, 'index']);
    Route::post  ('/integrations',                    [IntegrationsController::class, 'store']);
    Route::get   ('/integrations/{id}',               [IntegrationsController::class, 'show']);
    Route::put   ('/integrations/{id}',               [IntegrationsController::class, 'update']);
    Route::delete('/integrations/{id}',               [IntegrationsController::class, 'destroy']);
    Route::post  ('/integrations/{id}/test',          [IntegrationsController::class, 'test']);
    Route::get   ('/integrations/{id}/dictionaries',  [IntegrationsController::class, 'dictionaries']);
    Route::post  ('/integrations/{id}/sync',          [IntegrationsController::class, 'sync']);
    Route::get   ('/integrations/{id}/runs',          [IntegrationsController::class, 'runs']);

    // Архивная копия данных компании
    Route::get ('/backup/summary', [BackupController::class, 'summary']);
    Route::get ('/backup/export',  [BackupController::class, 'export']);
    Route::post('/backup/inspect', [BackupController::class, 'inspect']);
    Route::post('/backup/import',  [BackupController::class, 'import']);

    Route::get('/settings/edit-lock-date',       [SettingsController::class, 'showLockDate']);
    Route::put('/settings/edit-lock-date',       [SettingsController::class, 'updateLockDate']);

    // Модели распределения (система фондов) и фонды
    Route::get   ('/fund-schemes',      [FundSchemeController::class, 'index']);
    Route::post  ('/fund-schemes',      [FundSchemeController::class, 'store']);
    Route::get   ('/fund-schemes/{id}', [FundSchemeController::class, 'show']);
    Route::put   ('/fund-schemes/{id}', [FundSchemeController::class, 'update']);
    Route::delete('/fund-schemes/{id}', [FundSchemeController::class, 'destroy']);

    // Калькулятор план/факт по выбранной модели
    Route::get('/funds/calc', [FundsController::class, 'calc']);

    // Акт финансового планирования (документ)
    Route::get('/fund-plan-docs', [FundPlanDocController::class, 'show']);
    Route::put('/fund-plan-docs', [FundPlanDocController::class, 'save']);

    // Шаблоны операций (повтор регулярных проводок)
    Route::get('/operation-templates',            [OperationTemplatesController::class, 'index']);
    Route::post('/operation-templates',           [OperationTemplatesController::class, 'store']);
    Route::post('/operation-templates/{id}/use',  [OperationTemplatesController::class, 'use']);
    Route::delete('/operation-templates/{id}',    [OperationTemplatesController::class, 'destroy']);

    // ИИ-ввод операций (текст/голос → черновик)
    Route::get('/ai/status',           [AiController::class, 'status']);
    Route::post('/ai/parse-operation', [AiController::class, 'parseOperation']);
    Route::post('/ai/parse-file',      [AiController::class, 'parseFile']);
    Route::post('/ai/apply-links',     [AiController::class, 'applyLinks']);
    Route::post('/ai/apply-bulk',            [AiController::class, 'applyBulk']);
    Route::get('/ai/bulk-log',               [AiController::class, 'bulkLog']);
    Route::post('/ai/bulk-log/{id}/revert',  [AiController::class, 'revertBulk']);
    // Выписка: ИИ добивает нераспознанные строки и предлагает правила
    Route::post('/ai/classify-statement', [AiController::class, 'classifyStatement']);
    Route::post('/ai/apply-rules',        [AiController::class, 'applyRules']);
    Route::post('/ai/transcribe',      [AiController::class, 'transcribe']);

});
