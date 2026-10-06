<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Info;
use App\Services\BulkInfoEditor;
use App\Services\History\History;
use App\Services\InfoReferences;
use App\Services\History\HistoryPresenter;
use App\Services\History\HistoryRestorer;
use Illuminate\Http\Request;

class InfoController extends TenantController
{
    private function model(): Info
    {
        return (new Info)->setConnection($this->dbName);
    }

    public function index(Request $request)
    {
        $this->initTenant($request);

        $query = $this->model()->newQuery()->active()
            ->orderBy('type')
            ->orderBy('sort_order');

        if ($request->type) {
            $query->ofType($request->type);
        }

        return response()->json(['data' => $query->get()]);
    }

    /**
     * GET /info/{id}/references — кто ссылается на элемент.
     *
     * Один и тот же ответ на два вопроса: «можно ли его тронуть» и «чем он
     * вообще занят». Второй спрашивают чаще: статью заводят, пользуются ею
     * месяцами, а потом не помнят, куда она попадает.
     */
    public function references(Request $request, int $id)
    {
        $this->initTenant($request);

        $info = $this->model()->newQuery()->findOrFail($id);

        return response()->json(
            ['name' => $info->name, 'type' => $info->type]
            + InfoReferences::lists($this->dbName, (int) $info->id, $this->scope)
        );
    }

    /** GET /info/{id}/history — кто и когда правил элемент справочника */
    public function history(Request $request, int $id)
    {
        $this->initTenant($request);

        return response()->json([
            'data' => (new HistoryPresenter($this->dbName))->forObject('info', $id),
        ]);
    }

    /**
     * POST /info/{id}/restore/{version} — вернуть элемент к версии.
     *
     * Удалённый при этом оживает: если человек возвращает версию, он хочет
     * элемент обратно. Смена вида справочника задним числом не пройдёт, пока
     * на элемент ссылаются операции.
     */
    public function restore(Request $request, int $id, int $version)
    {
        $this->initTenant($request);
        app(History::class)->source('manual');

        $res = (new HistoryRestorer($this->dbName, $this->scope, $this->editLockDate()))
            ->restore('info', $id, $version);

        return response()->json($res, $res['ok'] ? 200 : 422);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'        => 'required|string|max:255',
            'type'        => 'required|string',
            'code'        => 'nullable|string|max:35',
            'description' => 'nullable|string',
            'inn'         => 'nullable|string|max:12',
            'parent_id'   => 'nullable|integer',
            'sort_order'  => 'nullable|integer',
            'expense_kind' => 'nullable|string|in:' . implode(',', Info::EXPENSE_KINDS),
            'flow_kind'    => 'nullable|string|in:' . implode(',', Info::FLOW_KINDS),
            'default_expense_id' => 'nullable|integer',
        ]);

        $info = $this->model()->newQuery()->create([
            'name'        => $data['name'],
            'type'        => $data['type'],
            'code'        => $data['code'] ?? null,
            'description' => $data['description'] ?? null,
            'inn'         => $data['inn'] ?? null,
            'parent_id'   => $data['parent_id'] ?? null,
            'sort_order'  => $data['sort_order'] ?? 0,
            'is_active'   => true,
            'expense_kind' => $data['expense_kind'] ?? 'fixed',
            'flow_kind'    => $data['flow_kind'] ?? 'operating',
            'default_expense_id' => $data['default_expense_id'] ?? null,
        ]);

        return response()->json(['data' => $info], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'name'        => 'required|string|max:255',
            'type'        => 'required|string',
            'code'        => 'nullable|string|max:35',
            'description' => 'nullable|string',
            'inn'         => 'nullable|string|max:12',
            'parent_id'   => 'nullable|integer',
            'sort_order'  => 'nullable|integer',
            'is_active'   => 'nullable|boolean',
            'expense_kind' => 'nullable|string|in:' . implode(',', Info::EXPENSE_KINDS),
            'flow_kind'    => 'nullable|string|in:' . implode(',', Info::FLOW_KINDS),
            'default_expense_id' => 'nullable|integer',
        ]);

        $info = $this->model()->newQuery()->findOrFail($id);

        /**
         * Сменить справочник у элемента, на который уже ссылаются, нельзя.
         *
         * Ссылки хранят id, а не тип, поэтому смена ничего не переносит: она
         * молча меняет смысл того, что уже записано. Контрагент, ставший
         * статьёй расхода, остаётся лежать в слоте под контрагентов, и
         * оборотка начинает показывать статью там, где её быть не может.
         */
        if ($data['type'] !== $info->type) {
            $refs = InfoReferences::count($this->dbName, (int) $info->id);

            if ($refs) {
                return response()->json([
                    'message' => 'Нельзя сменить справочник у «' . $info->name . '»: на элемент ссылаются — '
                        . InfoReferences::describe($refs)
                        . '. Заведите новый элемент в нужном справочнике, а этот сделайте неактивным.',
                ], 422);
            }
        }

        $info->update($data);

        return response()->json(['data' => $info]);
    }

    /** POST /info/bulk-preview — что изменится, без записи */
    public function bulkPreview(Request $request)
    {
        $this->initTenant($request);

        [$ids, $set, $error] = $this->bulkInput($request);
        if ($error) return $error;

        return response()->json(app(BulkInfoEditor::class)->preview($this->dbName, $ids, $set));
    }

    /** POST /info/bulk-update — применить правку к пачке элементов */
    public function bulkUpdate(Request $request)
    {
        $this->initTenant($request);
        // Одна пачка на всю правку: в журнале это одно действие человека
        app(History::class)->source('bulk');

        [$ids, $set, $error] = $this->bulkInput($request);
        if ($error) return $error;

        $res = app(BulkInfoEditor::class)->apply($this->dbName, $ids, $set);

        return response()->json($res + ['ok' => true]);
    }

    /**
     * Разбор и проверка запроса массовой правки.
     *
     * Три правила, и каждое — про смысл, а не про формат:
     *  - пачка одного справочника: вид расхода у контрагента бессмыслен, а
     *    родитель из чужого справочника сломал бы дерево;
     *  - родитель — того же вида, что и переносимые;
     *  - вид расхода правим только у статей расхода, вид деятельности —
     *    только у статей ДДС.
     *
     * @return array{0: array<int>, 1: array<string, mixed>, 2: mixed}
     */
    private function bulkInput(Request $request): array
    {
        $data = $request->validate([
            'ids'              => 'required|array|min:1|max:1000',
            'ids.*'            => 'integer',
            'set'              => 'required|array|min:1',
            'set.parent_id'    => 'nullable|integer',
            'set.expense_kind' => 'nullable|string|in:' . implode(',', Info::EXPENSE_KINDS),
            'set.flow_kind'    => 'nullable|string|in:' . implode(',', Info::FLOW_KINDS),
        ]);

        $ids = array_values(array_unique(array_map('intval', $data['ids'])));
        $set = array_intersect_key($data['set'], array_flip(BulkInfoEditor::FIELDS));

        // Вид — это выбор из списка, «очистить» для него не бывает
        foreach (['expense_kind', 'flow_kind'] as $f) {
            if (array_key_exists($f, $set) && ($set[$f] === null || $set[$f] === '')) unset($set[$f]);
        }

        $fail = fn(string $message) => [[], [], response()->json(['message' => $message], 422)];

        if (!$set) return $fail('Не выбрано ни одного поля для изменения');

        $editor = app(BulkInfoEditor::class);
        $type   = $editor->commonType($this->dbName, $ids);

        if (!$type) {
            return $fail('Массовая правка возможна только внутри одного справочника: '
                . 'в выбранном наборе элементы разных видов или их уже нет');
        }

        foreach (BulkInfoEditor::FIELD_TYPES as $field => $onlyType) {
            if (array_key_exists($field, $set) && $type !== $onlyType) {
                return $fail('Это поле есть только у справочника «' . $onlyType . '», а выбраны элементы другого');
            }
        }

        if (!empty($set['parent_id'])) {
            $parent = $this->model()->newQuery()->find($set['parent_id']);

            if (!$parent)                 return $fail('Родитель не найден');
            if ($parent->type !== $type)  return $fail('Родитель должен быть из того же справочника');

            $set['parent_id'] = (int) $parent->id;
        } elseif (array_key_exists('parent_id', $set)) {
            $set['parent_id'] = null;     // «в корень» — осознанный выбор
        }

        return [$ids, $set, null];
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->model()->newQuery()->findOrFail($id)->delete();

        return response()->json(['message' => 'Удалено']);
    }
}
