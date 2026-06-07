<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Acquiring\AcquiringFeeRules;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Просмотр и редактирование правил эквайринг-свода (settings.acquiring_fee_rules).
 * Пользователь видит и правит понятные поля (банк/маркер/формат), а не regex.
 */
class SettingsController extends TenantController
{
    // GET /settings/acquiring-fee-rules
    public function acquiringFeeRules(Request $request)
    {
        $this->initTenant($request);

        // Если ключа ещё нет (например, тенант старее бэкафилла) — проставим дефолт,
        // чтобы UI всегда показывал актуальный набор, а строка появилась в settings.
        AcquiringFeeRules::ensureDefaults($this->dbName);

        return response()->json([
            'data'     => AcquiringFeeRules::load($this->dbName),
            'formats'  => AcquiringFeeRules::FORMATS,   // для выпадашки в UI
            'defaults' => AcquiringFeeRules::defaults(), // для кнопки «Сбросить»
        ]);
    }

    // PUT /settings/acquiring-fee-rules
    public function updateAcquiringFeeRules(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'rules'                 => 'required|array',
            'rules.*.bank'          => 'nullable|string|max:50',
            'rules.*.marker'        => 'required|string|max:255',
            'rules.*.amount_format' => 'required|string|in:' . implode(',', AcquiringFeeRules::FORMATS),
            'rules.*.is_active'     => 'nullable|boolean',
        ]);

        try {
            $clean = AcquiringFeeRules::validate($data['rules']);
        } catch (\InvalidArgumentException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        DB::connection($this->dbName)->table('settings')->updateOrInsert(
            ['key' => AcquiringFeeRules::SETTING_KEY],
            [
                'value'      => json_encode($clean, JSON_UNESCAPED_UNICODE),
                'updated_at' => now(),
                'created_at' => now(), // учитывается только при вставке
            ]
        );

        return response()->json(['data' => $clean]);
    }
}
