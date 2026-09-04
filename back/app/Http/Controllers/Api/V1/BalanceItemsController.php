<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BalanceItem;
use App\Services\ChartOfAccounts;
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

        // Системность больше не запрещает удаление: счета добавляются из
        // каталога по надобности, значит и убирать лишние логично. Держит счёт
        // не флаг, а то, что на него ссылается
        if ($blocker = $this->deleteBlocker($item)) {
            return response()->json(['message' => $blocker], 422);
        }

        $item->delete();

        return response()->json([
            'message' => $item->is_system
                ? 'Счёт удалён — вернуть его можно кнопкой «Добавить из списка»'
                : 'Счёт удалён',
        ]);
    }

    /**
     * Что мешает удалить счёт, если мешает.
     *
     * Проверяем всё, что ссылается на счёт: по id — операции, документы и виды
     * документов, по коду — карта разноски. Пропустить ссылку означало бы
     * оставить механизм с дырой на месте счёта, и вылезло бы это в самый
     * неподходящий момент — при проведении или разборе выписки.
     */
    private function deleteBlocker($item): ?string
    {
        $id = $item->id;

        $ops = $this->db()->table('operations')->whereNull('deleted_at')
            ->where(fn($q) => $q->where('in_bi_id', $id)->orWhere('out_bi_id', $id))->count();
        if ($ops > 0) {
            return "По счёту есть операции ({$ops}) — удаление заблокировано";
        }

        if ($this->model()->newQuery()->where('parent_id', $id)->exists()) {
            return 'У счёта есть подчинённые — сначала перенесите или удалите их';
        }

        if ($this->db()->table('category_postings')->where('counter_account_code', $item->code)->exists()) {
            return 'Счёт указан в карте разноски — сначала измените её';
        }

        $type = $this->db()->table('document_types')
            ->where(fn($q) => $q->where('head_bi_id', $id)->orWhere('item_bi_id', $id))
            ->value('name');
        if ($type) {
            return "Счёт задан в виде документа «{$type}» — сначала измените его настройку";
        }

        $docs = $this->db()->table('documents')->whereNull('deleted_at')->where('bi_id', $id)->count();
        if ($docs > 0) {
            return "Счёт стоит в шапке документов ({$docs}) — удаление заблокировано";
        }

        $lines = $this->db()->table('document_items as di')
            ->join('documents as d', 'd.id', '=', 'di.document_id')
            ->whereNull('d.deleted_at')
            ->where(fn($q) => $q->where('di.bi_id', $id)->orWhere('di.head_bi_id', $id))
            ->count();
        if ($lines > 0) {
            return "Счёт стоит в строках документов ({$lines}) — удаление заблокировано";
        }

        $project = $this->db()->table('projects')
            ->where(fn($q) => $q->where('outgoing_revenue_bi_id', $id)->orWhere('outgoing_cogs_bi_id', $id))
            ->value('name');
        if ($project) {
            return "Счёт указан в настройках проекта «{$project}» — сначала измените их";
        }

        return null;
    }

    // ── Каталог системных счетов ──────────────────────────────────────────────

    /** GET /balance-items/catalog — что можно добавить и что уже есть */
    public function catalog(Request $request)
    {
        $this->initTenant($request);

        $existing = $this->model()->newQuery()->pluck('code')->all();

        return response()->json([
            'groups' => ChartOfAccounts::groups(),
            'data'   => array_map(fn($a) => [
                'code'         => $a['code'],
                'name'         => $a['name'],
                'group'        => $a['group'],
                'parent_code'  => $a['parent_code'] ?? null,
                'info_1_type'  => $a['info_1_type'] ?? null,
                'info_2_type'  => $a['info_2_type'] ?? null,
                'has_quantity' => (bool) ($a['has_quantity'] ?? 0),
                'is_default'   => (bool) $a['default'],
                'hint'         => $a['hint'] ?? null,
                'exists'       => in_array($a['code'], $existing, true),
            ], ChartOfAccounts::all()),
        ]);
    }

    /** POST /balance-items/catalog — добавить выбранные счета */
    public function addFromCatalog(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'codes'   => 'required|array|min:1',
            'codes.*' => 'string',
        ]);

        $idsByCode = $this->model()->newQuery()->pluck('id', 'code')->all();
        $created   = [];

        foreach ($data['codes'] as $code) {
            $account = ChartOfAccounts::byCode($code);
            if (!$account || isset($idsByCode[$code])) continue;

            // Родитель приезжает вместе с ребёнком: счёт без своей группы
            // повис бы в плане счетов сиротой
            $parentCode = $account['parent_code'] ?? null;
            if ($parentCode && !isset($idsByCode[$parentCode])) {
                $parent = ChartOfAccounts::byCode($parentCode);
                if ($parent) {
                    $idsByCode[$parentCode] = $this->insertFromCatalog($parent, $idsByCode);
                    $created[] = $parent['code'];
                }
            }

            $idsByCode[$code] = $this->insertFromCatalog($account, $idsByCode);
            $created[] = $code;
        }

        return response()->json([
            'message' => $created ? 'Счета добавлены' : 'Всё выбранное уже есть в плане счетов',
            'created' => $created,
        ]);
    }

    /**
     * Вставка счёта из каталога.
     *
     * Удаление счёта мягкое, поэтому сначала ищем удалённый с таким кодом и
     * поднимаем его: у него свой id, на который могли ссылаться документы и
     * виды, — новая строка оставила бы эти ссылки висеть на удалённой.
     *
     * Иначе вставляем с каталожным id, чтобы счета совпадали между базами.
     * Если id занят (счёт удалили, а номер достался другому) — вставляем без
     * него: одинаковость id приятна, но не обязательна.
     */
    private function insertFromCatalog(array $account, array $idsByCode): int
    {
        $trashed = $this->model()->newQuery()->onlyTrashed()
            ->where('code', $account['code'])->first();

        if ($trashed) {
            $trashed->restore();
            // Реквизиты возвращаем каталожные: счёт мог быть удалён как раз
            // потому, что его настроили неудачно
            $trashed->update(ChartOfAccounts::toRow($account, $idsByCode));
            return (int) $trashed->id;
        }

        $now = now();
        $row = ChartOfAccounts::toRow($account, $idsByCode) + [
            'created_at' => $now,
            'updated_at' => $now,
        ];

        $idTaken = $this->db()->table('balance_items')->where('id', $account['id'])->exists();

        return (int) $this->db()->table('balance_items')
            ->insertGetId($idTaken ? $row : $row + ['id' => $account['id']]);
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
