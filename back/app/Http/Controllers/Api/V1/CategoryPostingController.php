<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\CategoryPosting;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class CategoryPostingController extends TenantController
{
    private function model(): CategoryPosting
    {
        return (new CategoryPosting)->setConnection($this->dbName);
    }

    public function index(Request $request)
    {
        $this->initTenant($request);

        $postings = $this->model()->newQuery()
            ->orderBy('category')
            ->get();

        return response()->json(['data' => $postings]);
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $this->validatePayload($request);

        // Уникальность category проверяем вручную на тенантном соединении:
        // правило unique валидатора смотрит дефолтную БД, а не БД тенанта.
        $this->assertCategoryUnique($data['category'], null);

        $posting = $this->model()->newQuery()->create([
            'category'             => $data['category'],
            'counter_account_code' => $data['counter_account_code'] ?? null,
            'flow_info_id'         => $data['flow_info_id'] ?? null,
            'partner_mode'         => $data['partner_mode'] ?? 'from_inn',
            'is_active'            => $data['is_active'] ?? true,
        ]);

        return response()->json(['data' => $posting], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $this->validatePayload($request);

        $posting = $this->model()->newQuery()->findOrFail($id);

        $this->assertCategoryUnique($data['category'], $id);

        $posting->update($data);

        return response()->json(['data' => $posting]);
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $this->model()->newQuery()->findOrFail($id)->delete();

        return response()->json(['message' => 'Удалено']);
    }

    private function validatePayload(Request $request): array
    {
        return $request->validate([
            'category'             => 'required|string|max:40',
            'counter_account_code' => 'nullable|string|max:35',
            'flow_info_id'         => 'nullable|integer',
            'partner_mode'         => 'nullable|string|in:from_inn,none',
            'is_active'            => 'nullable|boolean',
        ]);
    }

    private function assertCategoryUnique(string $category, ?int $exceptId): void
    {
        $exists = $this->model()->newQuery()
            ->where('category', $category)
            ->when($exceptId, fn ($q) => $q->where('id', '!=', $exceptId))
            ->exists();

        if ($exists) {
            throw ValidationException::withMessages([
                'category' => "Разноска для категории «{$category}» уже существует.",
            ]);
        }
    }
}
