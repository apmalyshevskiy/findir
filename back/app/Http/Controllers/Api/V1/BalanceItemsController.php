<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BalanceItem;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * План счетов тенанта.
 *
 * Коды счетов — не косметика: на них ссылается карта разноски
 * (category_postings.counter_account_code) и по ним матчер выписки находит счёт.
 * Поэтому смена кода у используемого счёта блокируется, а системные счета
 * удалять нельзя.
 */
class BalanceItemsController extends TenantController
{
    /** Типы аналитик, допустимые в слотах info_1..3 */
    private const INFO_TYPES = ['partner', 'employee', 'department', 'cash', 'flow', 'expenses', 'product', 'revenue'];

    private function model(): BalanceItem
    {
        return (new BalanceItem)->setConnection($this->dbName);
    }

    private function db()
    {
        return DB::connection($this->dbName);
    }

    public function index(Request $request)
    {
        $this->initTenant($request);

        $items = $this->model()->newQuery()->orderBy('code')->get();

        // Счётчик использования — фронт показывает, что счёт нельзя удалить.
        // Дебет и кредит объединяем, фильтр по deleted_at — внутри подзапроса.
        $sub = $this->db()->table('operations')->whereNull('deleted_at')->select('in_bi_id as bi_id')
            ->unionAll($this->db()->table('operations')->whereNull('deleted_at')->select('out_bi_id as bi_id'));

        $used = $this->db()->query()->fromSub($sub, 'u')
            ->selectRaw('bi_id, COUNT(*) c')->groupBy('bi_id')->pluck('c', 'bi_id');

        return response()->json(['data' => $items->map(function ($i) use ($used) {
            $i->operations_count = (int) ($used[$i->id] ?? 0);
            return $i;
        })]);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);
        $data = $this->validated($request);

        if ($this->codeTaken($data['code'])) {
            return response()->json(['message' => "Счёт с кодом «{$data['code']}» уже существует"], 422);
        }

        $item = $this->model()->newQuery()->create($data + ['is_system' => false]);

        return response()->json(['data' => $item], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);
        $item = $this->model()->newQuery()->findOrFail($id);
        $data = $this->validated($request, $id);

        if ($data['code'] !== $item->code) {
            if ($this->codeTaken($data['code'], $id)) {
                return response()->json(['message' => "Счёт с кодом «{$data['code']}» уже существует"], 422);
            }
            // Код указан в карте разноски — смена «оторвёт» её от счёта
            $inPostings = $this->db()->table('category_postings')
                ->where('counter_account_code', $item->code)->exists();
            if ($inPostings) {
                return response()->json([
                    'message' => "Код «{$item->code}» используется в карте разноски. "
                        . 'Сначала измените разноску, иначе автоподстановка счёта сломается.',
                ], 422);
            }
        }

        // Свой родитель или потомок — получилось бы кольцо
        if (!empty($data['parent_id']) && $this->wouldLoop($id, (int) $data['parent_id'])) {
            return response()->json(['message' => 'Нельзя подчинить счёт самому себе или своему потомку'], 422);
        }

        $item->update($data);

        return response()->json(['data' => $item->fresh()]);
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);
        $item = $this->model()->newQuery()->findOrFail($id);

        if ($item->is_system) {
            return response()->json(['message' => 'Системный счёт удалить нельзя — он используется механизмами учёта'], 422);
        }

        $ops = $this->db()->table('operations')->whereNull('deleted_at')
            ->where(fn($q) => $q->where('in_bi_id', $id)->orWhere('out_bi_id', $id))->count();
        if ($ops > 0) {
            return response()->json(['message' => "По счёту есть операции ({$ops}) — удаление заблокировано"], 422);
        }

        if ($this->model()->newQuery()->where('parent_id', $id)->exists()) {
            return response()->json(['message' => 'У счёта есть подчинённые — сначала перенесите или удалите их'], 422);
        }

        if ($this->db()->table('category_postings')->where('counter_account_code', $item->code)->exists()) {
            return response()->json(['message' => 'Счёт указан в карте разноски — сначала измените её'], 422);
        }

        $item->delete();

        return response()->json(['message' => 'Счёт удалён']);
    }

    // ── Вспомогательное ───────────────────────────────────────────────────────

    private function validated(Request $request, ?int $id = null): array
    {
        $types = implode(',', self::INFO_TYPES);

        $data = $request->validate([
            'code'                 => 'required|string|max:20',
            'name'                 => 'required|string|max:255',
            'parent_id'            => 'nullable|integer',
            'info_1_type'          => "nullable|string|in:{$types}",
            'info_2_type'          => "nullable|string|in:{$types}",
            'info_3_type'          => "nullable|string|in:{$types}",
            'info_1_turnover_only' => 'nullable|boolean',
            'info_2_turnover_only' => 'nullable|boolean',
            'info_3_turnover_only' => 'nullable|boolean',
            'has_quantity'         => 'nullable|boolean',
        ]);

        $data['code'] = trim($data['code']);
        $data['name'] = trim($data['name']);
        foreach (['info_1_type', 'info_2_type', 'info_3_type'] as $f) {
            $data[$f] = $data[$f] ?? null;
        }
        foreach (['info_1_turnover_only', 'info_2_turnover_only', 'info_3_turnover_only', 'has_quantity'] as $f) {
            $data[$f] = !empty($data[$f]);
        }

        return $data;
    }

    private function codeTaken(string $code, ?int $exceptId = null): bool
    {
        return $this->model()->newQuery()
            ->where('code', $code)
            ->when($exceptId, fn($q) => $q->where('id', '!=', $exceptId))
            ->exists();
    }

    /** Не создаст ли назначение родителя цикл в иерархии. */
    private function wouldLoop(int $id, int $parentId): bool
    {
        $seen = 0;
        $cur  = $parentId;
        while ($cur && $seen++ < 50) {
            if ($cur === $id) return true;
            $cur = (int) $this->model()->newQuery()->where('id', $cur)->value('parent_id');
        }
        return false;
    }
}
