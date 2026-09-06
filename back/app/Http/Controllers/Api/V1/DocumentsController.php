<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentItem;
use App\Services\Documents\DocumentService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class DocumentsController extends TenantController
{
    /** Справочник видов, по коду. Читается один раз на запрос */
    private ?array $typesByCode = null;

    private function types(): array
    {
        return $this->typesByCode ??= DB::connection($this->dbName)
            ->table('document_types')->get()->keyBy('code')->all();
    }

    /** Коды видов документов, заведённых у тенанта */
    private function typeCodes(): array
    {
        return array_keys($this->types());
    }

    private function model(): Document
    {
        return (new Document)->setConnection($this->dbName);
    }

    private function itemModel(): DocumentItem
    {
        return (new DocumentItem)->setConnection($this->dbName);
    }

    // ─── GET /documents ───────────────────────────────────────

    public function index(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $query = $this->model()->newQuery()
            ->with(['balanceItem', 'info1', 'info2', 'info3'])
            ->orderByDesc('date')
            ->orderByDesc('id');

        if ($request->project_id) $query->where('project_id', $request->project_id);
        if ($request->type)       $query->where('type', $request->type);
        if ($request->status)     $query->where('status', $request->status);
        if ($request->date_from)  $query->where('date', '>=', $request->date_from);
        // Дата документа — datetime, а граница периода приходит днём: без
        // конца суток фильтр терял всё, что заведено сегодня после полуночи
        if ($request->date_to)    $query->where('date', '<=', $this->endOfDay($request->date_to));

        $this->applySearch($query, $request);
        $this->excludeHidden($query);

        $perPage = $request->per_page ?? 50;
        $page    = $request->page ?? 1;
        $total   = $query->count();
        $items   = $query->offset(($page - 1) * $perPage)->limit($perPage)->get();

        return response()->json([
            'data'  => $items->map(fn($d) => $this->formatDocument($d)),
            'total' => $total,
            'page'  => (int) $page,
        ]);
    }

    /** Граница периода: дата без времени означает весь день целиком. */
    private function endOfDay(string $date): string
    {
        return strlen(trim($date)) <= 10 ? trim($date) . ' 23:59:59' : $date;
    }

    /**
     * Отбор по счёту, аналитике и строке поиска.
     *
     * Счёт и аналитику ищем и в шапке, и в строках: документ ищут по тому, что
     * в нём есть. «Покажи, где покупали сырьё» — это про строку авансового
     * отчёта, а не про его шапку, и отбор только по шапке отвечал бы «ничего».
     */
    private function applySearch($query, Request $request): void
    {
        $inItems = fn(callable $where) => function ($q) use ($where) {
            $q->from('document_items as di')->whereColumn('di.document_id', 'documents.id');
            $where($q);
        };

        if ($biId = (int) $request->bi_id) {
            $query->where(fn($q) => $q
                ->where('bi_id', $biId)
                ->orWhereExists($inItems(fn($s) => $s->where(
                    fn($w) => $w->where('di.bi_id', $biId)->orWhere('di.head_bi_id', $biId)
                ))));
        }

        if ($infoId = (int) $request->info_id) {
            $head = ['info_1_id', 'info_2_id', 'info_3_id'];
            $line = ['di.info_1_id', 'di.info_2_id', 'di.info_3_id',
                     'di.head_info_1_id', 'di.head_info_2_id', 'di.head_info_3_id'];

            $query->where(function ($q) use ($infoId, $head, $line, $inItems) {
                foreach ($head as $f) $q->orWhere($f, $infoId);
                $q->orWhereExists($inItems(function ($s) use ($infoId, $line) {
                    $s->where(function ($w) use ($infoId, $line) {
                        foreach ($line as $f) $w->orWhere($f, $infoId);
                    });
                }));
            });
        }

        $search = trim((string) $request->search);
        if ($search === '') return;

        // \ % _ в поиске — обычные символы, а не подстановка: артикул «12%»
        // иначе нашёл бы всё подряд
        $like   = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\%', '\_'], $search) . '%';
        $amount = $this->searchAmount($search);

        $query->where(function ($q) use ($like, $amount, $inItems) {
            $q->where('number', 'like', $like)
                ->orWhere('external_number', 'like', $like)
                ->orWhere('note', 'like', $like)
                ->orWhere('content', 'like', $like)
                ->orWhereExists($inItems(fn($s) => $s->where('di.note', 'like', $like)));

            // Число ищем и как сумму: «850» чаще означает сумму, чем текст
            if ($amount !== null) {
                $q->orWhere('amount', $amount)
                    ->orWhereExists($inItems(fn($s) => $s->where('di.amount', $amount)));
            }
        });
    }

    /** Строка поиска как сумма — или null, если это не число. */
    private function searchAmount(string $search): ?float
    {
        $clean = str_replace([' ', "\u{00A0}", ','], ['', '', '.'], $search);

        return is_numeric($clean) ? (float) $clean : null;
    }

    /**
     * Документы с закрытыми счетами — вон из выборки.
     *
     * Правило другое, чем у операций, и намеренно: документ — это бумага, сумма
     * которой обязана сходиться со строками. Показать авансовый отчёт без двух
     * строк хуже, чем не показать его вовсе, а ведомость начисления зарплаты
     * «наполовину» не должна существовать в принципе.
     */
    private function excludeHidden($query): void
    {
        if ($this->scope->isEmpty()) return;

        $hidden = $this->scope->hiddenIds();

        $query->whereNotIn('bi_id', $hidden)
            ->whereNotExists(function ($q) use ($hidden) {
                $q->from('document_items as di')
                    ->whereColumn('di.document_id', 'documents.id')
                    ->where(fn($w) => $w->whereIn('di.bi_id', $hidden)
                        ->orWhereIn('di.head_bi_id', $hidden));
            });
    }

    /** Виден ли документ этому человеку. */
    private function docHidden($doc): bool
    {
        if ($this->scope->isEmpty()) return false;

        if ($this->scope->hides($doc->bi_id)) return true;

        $hidden = $this->scope->hiddenIds();

        return DB::connection($this->dbName)->table('document_items')
            ->where('document_id', $doc->id)
            ->where(fn($q) => $q->whereIn('bi_id', $hidden)->orWhereIn('head_bi_id', $hidden))
            ->exists();
    }

    /**
     * Скрытого документа для человека не существует — отвечаем «не найден».
     *
     * Не «нет прав»: отказ подтвердил бы, что документ с таким номером есть,
     * а по номеру и дате уже можно многое понять.
     */
    private function docNotFound(): JsonResponse
    {
        return response()->json(['message' => 'Документ не найден'], 404);
    }

    // ─── GET /documents/{id} ──────────────────────────────────

    public function show(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()
            ->with([
                'balanceItem', 'info1', 'info2', 'info3',
                'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
                'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
            'items.headBalanceItem', 'items.headInfo1', 'items.headInfo2', 'items.headInfo3',
            ])
            ->findOrFail($id);

        if ($this->docHidden($doc)) return $this->docNotFound();

        return response()->json(['data' => $this->formatDocument($doc, withItems: true)]);
    }

    // ─── POST /documents ──────────────────────────────────────

    public function store(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate($this->rules());

        if ($resp = $this->lockError($data['date'])) return $resp;

        if ($this->payloadHasHidden($data)) return $this->hiddenAccountError('документе');

        $doc = $this->model()->newQuery()->make();
        $doc->fill($this->docData($data));
        $doc->status     = 'draft';
        $doc->created_by = $this->getCurrentUserId($request);

        // Для outgoing_invoice копируем поля из project (если не переданы явно)
        DocumentService::fillFromProject($doc);

        $doc->save();

        $this->syncItems($doc, $data['items'] ?? []);

        // Пересчитываем сумму шапки из строк (чтобы она отображалась в списке)
        $this->recalcAmount($doc);

        $doc->load([
            'balanceItem', 'info1', 'info2', 'info3',
            'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
            'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
            'items.headBalanceItem', 'items.headInfo1', 'items.headInfo2', 'items.headInfo3',
        ]);

        return response()->json(['data' => $this->formatDocument($doc, withItems: true)], 201);
    }

    // ─── PUT /documents/{id} ──────────────────────────────────

    public function update(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()->findOrFail($id);

        if ($this->docHidden($doc)) return $this->docNotFound();

        // Нельзя трогать документ в закрытом периоде
        if ($resp = $this->lockError($doc->date)) return $resp;

        if ($doc->isPosted()) {
            return response()->json([
                'message' => 'Нельзя редактировать проведённый документ. Сначала отмените проведение.',
            ], 422);
        }

        $data = $request->validate($this->rules());

        // Нельзя переносить документ в закрытый период
        if ($resp = $this->lockError($data['date'])) return $resp;

        if ($this->payloadHasHidden($data)) return $this->hiddenAccountError('документе');

        $doc->fill($this->docData($data));
        $doc->save();

        $this->syncItems($doc, $data['items'] ?? []);

        // Пересчитываем сумму шапки из строк
        $this->recalcAmount($doc);

        $doc->load([
            'balanceItem', 'info1', 'info2', 'info3',
            'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
            'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
            'items.headBalanceItem', 'items.headInfo1', 'items.headInfo2', 'items.headInfo3',
        ]);

        return response()->json(['data' => $this->formatDocument($doc, withItems: true)]);
    }

    // ─── POST /documents/{id}/post ────────────────────────────

    public function post(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()
            ->with('items')
            ->findOrFail($id);

        if ($this->docHidden($doc)) return $this->docNotFound();

        // Проведение создаёт операции в периоде документа — запрещаем в закрытом периоде
        if ($resp = $this->lockError($doc->date)) return $resp;

        if ($doc->items->isEmpty()) {
            return response()->json(['message' => 'Нельзя провести документ без строк.'], 422);
        }

        DocumentService::post($doc);

        $doc->refresh()->load([
            'balanceItem', 'info1', 'info2', 'info3',
            'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
            'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
            'items.headBalanceItem', 'items.headInfo1', 'items.headInfo2', 'items.headInfo3',
        ]);

        return response()->json(['data' => $this->formatDocument($doc, withItems: true)]);
    }

    // ─── POST /documents/{id}/cancel ─────────────────────────

    public function cancel(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()->findOrFail($id);

        if ($this->docHidden($doc)) return $this->docNotFound();

        // Отмена проведения удаляет операции в периоде документа — запрещаем в закрытом периоде
        if ($resp = $this->lockError($doc->date)) return $resp;

        if (!$doc->isPosted()) {
            return response()->json(['message' => 'Документ не проведён.'], 422);
        }

        DocumentService::cancel($doc);

        return response()->json(['data' => $this->formatDocument($doc->fresh())]);
    }

    // ─── GET /documents/{id}/changes ──────────────────────────

    /**
     * Движения по счетам, которые дал документ.
     *
     * В операции такая вкладка уже есть, но в операцию, рождённую документом,
     * не зайти — она правится только через документ. Поэтому те же движения
     * показываем здесь: вопрос «почему в оборотке такая цифра» разрешается
     * одинаково, с какой стороны ни подойди.
     */
    public function changes(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()->findOrFail($id);

        if ($this->docHidden($doc)) return $this->docNotFound();

        $rows = DB::connection($this->dbName)->table('balance_changes as bc')
            ->join('operations as o', 'o.id', '=', 'bc.operation_id')
            ->leftJoin('balance_items as bi', 'bi.id', '=', 'bc.bi_id')
            ->leftJoin('info as i1', 'i1.id', '=', 'bc.info_1_id')
            ->leftJoin('info as i2', 'i2.id', '=', 'bc.info_2_id')
            ->leftJoin('info as i3', 'i3.id', '=', 'bc.info_3_id')
            ->where('o.table_name', 'documents')
            ->where('o.table_id', (string) $doc->id)
            // У balance_changes нет ключа, поэтому порядок задаём явно:
            // строки идут по операциям, внутри операции дебет первым
            ->orderBy('bc.operation_id')
            ->orderByRaw("bc.side = 'credit'")
            ->get([
                'bc.operation_id', 'bc.side', 'bc.date', 'bc.amount', 'bc.quantity',
                'bc.bi_id', 'bi.code as bi_code', 'bi.name as bi_name',
                'bc.content',
                'i1.name as info_1_name', 'i2.name as info_2_name', 'i3.name as info_3_name',
            ]);

        return response()->json([
            'data'      => $rows,
            'is_posted' => $doc->isPosted(),
            'status'    => $doc->status,
        ]);
    }

    // ─── DELETE /documents/{id} ───────────────────────────────

    public function destroy(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()->findOrFail($id);

        if ($this->docHidden($doc)) return $this->docNotFound();

        // Нельзя удалять документ в закрытом периоде
        if ($resp = $this->lockError($doc->date)) return $resp;

        DocumentService::delete($doc);

        return response()->json(['message' => 'Документ удалён']);
    }

    // ─── Вспомогательные ──────────────────────────────────────

    private function rules(): array
    {
        return [
            'date'            => 'required|date',
            'number'          => 'nullable|string|max:50',
            'external_number' => 'nullable|string|max:100',
            'external_date'   => 'nullable|date',
            'project_id'      => 'required|integer',
            // Вид документа живёт в справочнике тенанта, поэтому список
            // допустимых значений берём оттуда, а не из константы
            'type'            => ['required', 'string', Rule::in($this->typeCodes())],
            'bi_id'           => 'required|integer',
            'info_1_id'       => 'nullable|integer',
            'info_2_id'       => 'nullable|integer',
            'info_3_id'       => 'nullable|integer',
            'revenue_bi_id'   => 'nullable|integer',
            'cogs_bi_id'      => 'nullable|integer',
            'revenue_item_id' => 'nullable|integer',
            'note'            => 'nullable|string',
            'extra'           => 'nullable|array',
            'items'                  => 'nullable|array',
            'items.*.bi_id'          => 'required_with:items|integer',
            'items.*.info_1_id'      => 'nullable|integer',
            'items.*.info_2_id'      => 'nullable|integer',
            'items.*.info_3_id'      => 'nullable|integer',
            // Корреспондирующая сторона строки: пусто — берётся из шапки
            'items.*.head_bi_id'     => 'nullable|integer',
            'items.*.head_info_1_id' => 'nullable|integer',
            'items.*.head_info_2_id' => 'nullable|integer',
            'items.*.head_info_3_id' => 'nullable|integer',
            'items.*.quantity'       => 'nullable|numeric|min:0',
            'items.*.price'          => 'nullable|numeric|min:0',
            'items.*.amount'         => 'required_with:items|numeric',
            'items.*.amount_vat'     => 'nullable|numeric|min:0',
            'items.*.amount_cost'    => 'nullable|numeric|min:0',
            'items.*.note'           => 'nullable|string',
        ];
    }

    /**
     * Нет ли в присланном документе закрытого счёта.
     *
     * Проверяем и шапку, и строки, и переопределения в строках: id можно
     * подставить руками, минуя выпадающий список, где закрытых счетов нет.
     */
    private function payloadHasHidden(array $data): bool
    {
        if ($this->scope->isEmpty()) return false;

        $ids = [$data['bi_id'] ?? null, $data['revenue_bi_id'] ?? null, $data['cogs_bi_id'] ?? null];

        foreach ($data['items'] ?? [] as $row) {
            $ids[] = $row['bi_id'] ?? null;
            $ids[] = $row['head_bi_id'] ?? null;
        }

        return $this->scope->hidesAny($ids);
    }

    private function docData(array $data): array
    {
        return [
            'date'            => $data['date'],
            'number'          => $data['number'] ?? null,
            'external_number' => $data['external_number'] ?? null,
            'external_date'   => $data['external_date'] ?? null,
            'project_id'      => $data['project_id'],
            'type'            => $data['type'],
            'bi_id'           => $data['bi_id'],
            'info_1_id'       => $data['info_1_id'] ?? null,
            'info_2_id'       => $data['info_2_id'] ?? null,
            'info_3_id'       => $data['info_3_id'] ?? null,
            'revenue_bi_id'   => $data['revenue_bi_id'] ?? null,
            'cogs_bi_id'      => $data['cogs_bi_id'] ?? null,
            'revenue_item_id' => $data['revenue_item_id'] ?? null,
            'note'            => $data['note'] ?? null,
            'extra'           => $data['extra'] ?? null,
        ];
    }

    /**
     * Пересчитать и сохранить сумму шапки документа из строк.
     * Вызывается после syncItems при сохранении черновика.
     */
    private function recalcAmount(Document $doc): void
    {
        $amount = DB::connection($this->dbName)
            ->table('document_items')
            ->where('document_id', $doc->id)
            ->sum('amount');

        $vatSum = DB::connection($this->dbName)
            ->table('document_items')
            ->where('document_id', $doc->id)
            ->whereNotNull('amount_vat')
            ->sum('amount_vat');

        $doc->amount     = (float) $amount;
        $doc->amount_vat = $vatSum > 0 ? (float) $vatSum : null;
        $doc->save();
    }

    /**
     * Синхронизация строк: удаляем все старые, вставляем новые.
     */
    private function syncItems(Document $doc, array $items): void
    {
        DB::connection($this->dbName)
            ->table('document_items')
            ->where('document_id', $doc->id)
            ->delete();

        foreach ($items as $i => $row) {
            $this->itemModel()->newQuery()->create([
                'document_id' => $doc->id,
                'sort_order'  => $i,
                'bi_id'       => $row['bi_id'],
                'info_1_id'   => $row['info_1_id'] ?? null,
                'info_2_id'   => $row['info_2_id'] ?? null,
                'info_3_id'   => $row['info_3_id'] ?? null,
                'head_bi_id'     => $row['head_bi_id']     ?? null,
                'head_info_1_id' => $row['head_info_1_id'] ?? null,
                'head_info_2_id' => $row['head_info_2_id'] ?? null,
                'head_info_3_id' => $row['head_info_3_id'] ?? null,
                'quantity'    => $row['quantity'] ?? 0,
                'price'       => $row['price'] ?? 0,
                'amount'      => $row['amount'],
                'amount_vat'  => $row['amount_vat'] ?? null,
                'amount_cost' => $row['amount_cost'] ?? null,
                'note'        => $row['note'] ?? null,
            ]);
        }
    }

    /**
     * Получить ID текущего пользователя из Bearer токена.
     */
    private function getCurrentUserId(Request $request): ?int
    {
        $plainToken = $request->bearerToken();
        if (!$plainToken) return null;

        $row = DB::table('personal_access_tokens')
            ->where('token', hash('sha256', $plainToken))
            ->value('tokenable_id');

        return $row ? (int) $row : null;
    }

    private function formatDocument(Document $doc, bool $withItems = false): array
    {
        $result = [
            'id'                => $doc->id,
            'date'              => $doc->date?->format('Y-m-d H:i:s'),
            'number'            => $doc->number,
            'external_number'   => $doc->external_number,
            'external_date'     => $doc->external_date?->format('Y-m-d'),
            'project_id'        => $doc->project_id,
            'type'              => $doc->type,
            // Название вида и сторона шапки — чтобы список показывал документ,
            // не подгружая справочник строкой за строкой
            'type_name'         => $this->types()[$doc->type]->name      ?? $doc->type,
            'type_head_side'    => $this->types()[$doc->type]->head_side ?? 'credit',
            'status'            => $doc->status,
            'created_by'        => $doc->created_by,
            'bi_id'             => $doc->bi_id,
            'bi_code'           => $doc->balanceItem?->code,
            'bi_name'           => $doc->balanceItem?->name,
            'bi_info_1_type'    => $doc->balanceItem?->info_1_type,
            'bi_info_2_type'    => $doc->balanceItem?->info_2_type,
            'bi_info_3_type'    => $doc->balanceItem?->info_3_type,
            'info_1_id'         => $doc->info_1_id,
            'info_1_name'       => $doc->info1?->name,
            'info_2_id'         => $doc->info_2_id,
            'info_2_name'       => $doc->info2?->name,
            'info_3_id'         => $doc->info_3_id,
            'info_3_name'       => $doc->info3?->name,
            'revenue_bi_id'     => $doc->revenue_bi_id,
            'revenue_bi_code'   => $doc->revenueBalanceItem?->code,
            'revenue_bi_name'   => $doc->revenueBalanceItem?->name,
            'cogs_bi_id'        => $doc->cogs_bi_id,
            'cogs_bi_code'      => $doc->cogsBalanceItem?->code,
            'cogs_bi_name'      => $doc->cogsBalanceItem?->name,
            'revenue_item_id'   => $doc->revenue_item_id,
            'revenue_item_name' => $doc->revenueItem?->name,
            'amount'            => $doc->amount,
            'amount_vat'        => $doc->amount_vat,
            'content'           => $doc->content,
            'note'              => $doc->note,
            'extra'             => $doc->extra,
            'created_at'        => $doc->created_at,
            'updated_at'        => $doc->updated_at,
        ];

        if ($withItems) {
            $result['items'] = $doc->items->map(fn($item) => [
                'id'           => $item->id,
                'sort_order'   => $item->sort_order,
                'bi_id'        => $item->bi_id,
                'bi_code'      => $item->balanceItem?->code,
                'bi_name'      => $item->balanceItem?->name,
                'bi_info_1_type' => $item->balanceItem?->info_1_type,
                'bi_info_2_type' => $item->balanceItem?->info_2_type,
                'bi_info_3_type' => $item->balanceItem?->info_3_type,
                'info_1_id'    => $item->info_1_id,
                'info_1_name'  => $item->info1?->name,
                'info_2_id'    => $item->info_2_id,
                'info_2_name'  => $item->info2?->name,
                'info_3_id'    => $item->info_3_id,
                'info_3_name'  => $item->info3?->name,
                // Корреспондирующая сторона строки. Пустые поля берутся из
                // шапки — подставляет их проведение, не форма
                'head_bi_id'        => $item->head_bi_id,
                'head_bi_code'      => $item->headBalanceItem?->code,
                'head_bi_name'      => $item->headBalanceItem?->name,
                'head_info_1_id'    => $item->head_info_1_id,
                'head_info_1_name'  => $item->headInfo1?->name,
                'head_info_2_id'    => $item->head_info_2_id,
                'head_info_2_name'  => $item->headInfo2?->name,
                'head_info_3_id'    => $item->head_info_3_id,
                'head_info_3_name'  => $item->headInfo3?->name,
                'quantity'     => $item->quantity,
                'price'        => $item->price,
                'amount'       => $item->amount,
                'amount_vat'   => $item->amount_vat,
                'amount_cost'  => $item->amount_cost,
                'content'      => $item->content,
                'note'         => $item->note,
            ])->values()->all();
        }

        return $result;
    }
}
