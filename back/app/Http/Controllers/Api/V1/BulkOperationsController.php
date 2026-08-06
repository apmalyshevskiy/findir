<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\BulkOperationEditor;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Массовая правка операций, выбранных галочками в списке.
 *
 * Предпросмотр обязателен по смыслу: пользователь должен увидеть, сколько
 * операций реально изменится и что будет пропущено (документы, закрытый период),
 * до того как нажмёт «Изменить».
 */
class BulkOperationsController extends TenantController
{
    public function __construct(private BulkOperationEditor $editor) {}

    public function preview(Request $request)
    {
        $this->initTenant($request);
        [$ids, $set, $side] = $this->validated($request);

        if (!$set) {
            return response()->json(['message' => 'Не выбрано ни одного поля для изменения'], 422);
        }

        return response()->json(
            $this->editor->preview($this->dbName, $ids, $set, $side, $this->editLockDate())
        );
    }

    public function update(Request $request)
    {
        $this->initTenant($request);
        [$ids, $set, $side] = $this->validated($request);

        if (!$set) {
            return response()->json(['message' => 'Не выбрано ни одного поля для изменения'], 422);
        }

        $res = $this->editor->apply($this->dbName, $ids, $set, $side, $this->editLockDate());

        return response()->json($res + ['ok' => true]);
    }

    /** Журнал массовых правок — и ручных, и сделанных через ИИ. */
    public function log(Request $request)
    {
        $this->initTenant($request);

        $rows = DB::connection($this->dbName)
            ->table('bulk_update_log')->orderByDesc('id')->limit(50)->get();

        return response()->json(['data' => $rows->map(fn($r) => [
            'id'          => $r->id,
            'description' => $r->description,
            'affected'    => (int) $r->affected,
            'reverted_at' => $r->reverted_at,
            'created_at'  => $r->created_at,
        ])->values()]);
    }

    public function revert(Request $request, int $id)
    {
        $this->initTenant($request);

        $res = $this->editor->revert($this->dbName, $id, $this->editLockDate());

        return response()->json($res, ($res['ok'] ?? false) ? 200 : 422);
    }

    /**
     * Разбор запроса. Неизвестные ключи в set до сервиса не доходят —
     * там ещё раз отсекаются по белому списку полей.
     */
    private function validated(Request $request): array
    {
        $types = implode(',', BulkOperationEditor::ANALYTIC_TYPES);

        $data = $request->validate([
            'ids'              => 'required|array|min:1|max:1000',
            'ids.*'            => 'integer',
            'side'             => 'nullable|string|in:debit,credit,any',
            'set'              => 'required|array|min:1',
            'set.in_bi_id'     => 'nullable|integer|exists:' . $this->dbName . '.balance_items,id',
            'set.out_bi_id'    => 'nullable|integer|exists:' . $this->dbName . '.balance_items,id',
            'set.project_id'   => 'nullable|integer|exists:' . $this->dbName . '.projects,id',
            'set.content'      => 'nullable|string|max:1000',
            'set.note'         => 'nullable|string|max:1000',
            'set.analytics'    => 'nullable|array',
            'set.analytics.*'  => 'nullable|integer',
        ], [], ['set.analytics.*' => 'аналитика']);

        // Тип аналитики должен быть из списка — ключи приходят из формы
        $analytics = [];
        foreach (($data['set']['analytics'] ?? []) as $type => $val) {
            if (in_array($type, BulkOperationEditor::ANALYTIC_TYPES, true)) {
                $analytics[$type] = $val;
            }
        }

        $set = array_intersect_key($data['set'], array_flip(BulkOperationEditor::FIELDS));

        // Счета и проект у операции обязательны — «очистить» для них не бывает
        foreach (['in_bi_id', 'out_bi_id', 'project_id'] as $f) {
            if (array_key_exists($f, $set) && $set[$f] === null) unset($set[$f]);
        }

        if ($analytics) $set['analytics'] = $analytics;

        return [
            array_values(array_unique(array_map('intval', $data['ids']))),
            $set,
            $data['side'] ?? 'any',
        ];
    }
}
