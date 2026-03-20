<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentItem;
use App\Services\Documents\DocumentService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class DocumentsController extends TenantController
{
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
        if ($request->date_to)    $query->where('date', '<=', $request->date_to);

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

    // ─── GET /documents/{id} ──────────────────────────────────

    public function show(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()
            ->with([
                'balanceItem', 'info1', 'info2', 'info3',
                'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
                'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
            ])
            ->findOrFail($id);

        return response()->json(['data' => $this->formatDocument($doc, withItems: true)]);
    }

    // ─── POST /documents ──────────────────────────────────────

    public function store(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate($this->rules());

        $doc = $this->model()->newQuery()->make();
        $doc->fill($this->docData($data));
        $doc->status     = 'draft';
        $doc->created_by = $this->getCurrentUserId($request);

        // Для outgoing_invoice копируем поля из project (если не переданы явно)
        DocumentService::fillFromProject($doc);

        $doc->save();

        $this->syncItems($doc, $data['items'] ?? []);

        $doc->load([
            'balanceItem', 'info1', 'info2', 'info3',
            'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
            'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
        ]);

        return response()->json(['data' => $this->formatDocument($doc, withItems: true)], 201);
    }

    // ─── PUT /documents/{id} ──────────────────────────────────

    public function update(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()->findOrFail($id);

        if ($doc->isPosted()) {
            return response()->json([
                'message' => 'Нельзя редактировать проведённый документ. Сначала отмените проведение.',
            ], 422);
        }

        $data = $request->validate($this->rules());

        $doc->fill($this->docData($data));
        $doc->save();

        $this->syncItems($doc, $data['items'] ?? []);

        $doc->load([
            'balanceItem', 'info1', 'info2', 'info3',
            'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
            'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
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

        if ($doc->items->isEmpty()) {
            return response()->json(['message' => 'Нельзя провести документ без строк.'], 422);
        }

        DocumentService::post($doc);

        $doc->refresh()->load([
            'balanceItem', 'info1', 'info2', 'info3',
            'revenueBalanceItem', 'cogsBalanceItem', 'revenueItem',
            'items.balanceItem', 'items.info1', 'items.info2', 'items.info3',
        ]);

        return response()->json(['data' => $this->formatDocument($doc, withItems: true)]);
    }

    // ─── POST /documents/{id}/cancel ─────────────────────────

    public function cancel(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()->findOrFail($id);

        if (!$doc->isPosted()) {
            return response()->json(['message' => 'Документ не проведён.'], 422);
        }

        DocumentService::cancel($doc);

        return response()->json(['data' => $this->formatDocument($doc->fresh())]);
    }

    // ─── DELETE /documents/{id} ───────────────────────────────

    public function destroy(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $doc = $this->model()->newQuery()->findOrFail($id);

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
            'type'            => 'required|in:incoming_invoice,outgoing_invoice',
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
            'items.*.quantity'       => 'nullable|numeric|min:0',
            'items.*.price'          => 'nullable|numeric|min:0',
            'items.*.amount'         => 'required_with:items|numeric',
            'items.*.amount_vat'     => 'nullable|numeric|min:0',
            'items.*.amount_cost'    => 'nullable|numeric|min:0',
            'items.*.note'           => 'nullable|string',
        ];
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
