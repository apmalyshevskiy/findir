<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\DocumentType;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Виды документов.
 *
 * Вид описывает, во что превращается документ при проведении: счёт и сторона
 * шапки, счёт строк, какие колонки показывать. Проведение общее на все виды
 * (UniversalStrategy), поэтому новый вид заводится здесь, а не в коде.
 *
 * Исключение — расходная накладная: у неё собственный движок (выручка и
 * себестоимость), она помечена системной и удалению не подлежит.
 */
class DocumentTypesController extends TenantController
{
    private function model(): DocumentType
    {
        return (new DocumentType)->setConnection($this->dbName);
    }

    public function index(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $query = $this->model()->newQuery()
            ->with(['headBalanceItem', 'itemBalanceItem'])
            ->orderBy('sort_order')->orderBy('id');

        // Список документов зовёт с active=1: выключенный вид не должен
        // появляться вкладкой, но остаётся в справочнике и в старых документах
        if ($request->boolean('active')) {
            $query->where('is_active', true);
        }

        // Виды по закрытым счетам НЕ прячем.
        //
        // head_bi_id и item_bi_id — это подстановка для нового документа, а не
        // ограничение: счёт шапки и счёт каждой строки хранятся в самом
        // документе и свободно меняются. Спрятав вид, мы убирали вкладку целиком
        // и вместе с ней все документы этого вида — включая те, где закрытого
        // счёта нет вовсе. Закрытые счета вырезаются по документам, в
        // DocumentsController; сама подстановка гасится в format().

        $used = DB::connection($this->dbName)->table('documents')
            ->whereNull('deleted_at')
            ->selectRaw('type, COUNT(*) c')->groupBy('type')->pluck('c', 'type');

        return response()->json([
            'data' => $query->get()->map(fn($t) => $this->format($t, (int) ($used[$t->code] ?? 0))),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $this->validated($request);
        $data['code'] = $this->makeCode($data['name']);

        $type = $this->model()->newQuery()->create($data);
        $type->load(['headBalanceItem', 'itemBalanceItem']);

        return response()->json(['data' => $this->format($type, 0)], 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $type = $this->model()->newQuery()->findOrFail($id);
        $data = $this->validated($request);

        // Код не меняется никогда: на него ссылаются созданные документы и
        // импорт из учётных систем. Меняется только название
        if ($type->is_system) {
            // У системного вида счета и сторона заданы его движком — правится
            // только название, порядок и включённость
            $data = array_intersect_key($data, array_flip(['name', 'is_active', 'sort_order']));
        }

        $type->update($data);
        $type->load(['headBalanceItem', 'itemBalanceItem']);

        return response()->json(['data' => $this->format($type, $this->documentCount($type->code))]);
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $type = $this->model()->newQuery()->findOrFail($id);

        if ($type->is_system) {
            return response()->json([
                'message' => 'Системный вид удалить нельзя — за ним стоит собственная логика проведения. Его можно выключить.',
            ], 422);
        }

        $count = $this->documentCount($type->code);
        if ($count > 0) {
            return response()->json([
                'message' => "По этому виду есть документы ({$count}) — удаление заблокировано. Вид можно выключить.",
            ], 422);
        }

        $type->delete();

        return response()->json(['message' => 'Вид документа удалён']);
    }

    // ── Вспомогательное ───────────────────────────────────────────────────────

    private function validated(Request $request): array
    {
        $data = $request->validate([
            'name'          => 'required|string|max:100',
            'head_bi_id'    => 'nullable|integer',
            'head_side'     => 'required|in:debit,credit',
            'item_bi_id'    => 'nullable|integer',
            'show_quantity' => 'nullable|boolean',
            'show_price'    => 'nullable|boolean',
            'show_vat'      => 'nullable|boolean',
            // Что из корреспондирующей стороны вид выносит в строку колонкой
            'line_head_fields'   => 'nullable|array',
            'line_head_fields.*' => 'in:bi,info_1,info_2,info_3',
            'is_active'     => 'nullable|boolean',
            'sort_order'    => 'nullable|integer',
        ]);

        $data['name'] = trim($data['name']);
        foreach (['show_quantity', 'show_price', 'show_vat'] as $f) {
            $data[$f] = !empty($data[$f]);
        }
        // Пустой список храним как NULL: «ничего не выносим» и «не заполняли» —
        // одно и то же состояние, разводить их незачем
        $data['line_head_fields'] = array_values($data['line_head_fields'] ?? []) ?: null;
        $data['is_active']  = $request->has('is_active') ? $request->boolean('is_active') : true;
        $data['sort_order'] = $data['sort_order'] ?? 0;

        return $data;
    }

    /**
     * Код из названия: «Начисление ЗП» → «nachislenie-zp».
     *
     * Он живёт в documents.type и человеку на глаза не попадается, поэтому
     * важна только неизменность и уникальность, а не красота.
     */
    private function makeCode(string $name): string
    {
        $base = Str::slug(Str::ascii($name)) ?: 'doc';
        $code = $base;
        $i    = 2;

        while ($this->model()->newQuery()->where('code', $code)->exists()) {
            $code = $base . '-' . $i++;
        }

        return $code;
    }

    private function documentCount(string $code): int
    {
        return DB::connection($this->dbName)->table('documents')
            ->whereNull('deleted_at')->where('type', $code)->count();
    }

    private function format(DocumentType $t, int $documentsCount): array
    {
        // Подстановка на закрытый счёт человеку не нужна: он всё равно не
        // увидит его в списке счетов, а форма открылась бы с пустым местом
        // вместо счёта. Отдаём пусто — он выберет свой
        $headHidden = $this->scope->hides($t->head_bi_id);
        $itemHidden = $this->scope->hides($t->item_bi_id);

        return [
            'id'              => $t->id,
            'code'            => $t->code,
            'name'            => $t->name,
            'head_bi_id'      => $headHidden ? null : $t->head_bi_id,
            'head_bi_code'    => $headHidden ? null : $t->headBalanceItem?->code,
            'head_bi_name'    => $headHidden ? null : $t->headBalanceItem?->name,
            'head_side'       => $t->head_side,
            'item_bi_id'      => $itemHidden ? null : $t->item_bi_id,
            'item_bi_code'    => $itemHidden ? null : $t->itemBalanceItem?->code,
            'item_bi_name'    => $itemHidden ? null : $t->itemBalanceItem?->name,
            'show_quantity'   => $t->show_quantity,
            'show_price'      => $t->show_price,
            'show_vat'        => $t->show_vat,
            'line_head_fields' => $t->line_head_fields ?? [],
            'engine'          => $t->engine,
            'is_system'       => $t->is_system,
            'is_active'       => $t->is_active,
            'sort_order'      => $t->sort_order,
            'documents_count' => $documentsCount,
        ];
    }
}
