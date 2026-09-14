<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\History\HistoryPresenter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Журнал изменений: все правки подряд, новые сверху.
 *
 * История внутри объекта отвечает на вопрос «что стало с этой операцией».
 * Здесь другой вопрос — «что вообще происходило в базе»: кто работал вчера,
 * что принесла загрузка 1С, куда делись суммы после массовой правки.
 *
 * Подпись объекта берём из снимка самой версии, а не из текущего состояния:
 * так в журнале виден удалённый объект и видно, чем он был на тот момент, а не
 * чем стал после.
 */
class ChangeLogController extends TenantController
{
    private const PER_PAGE = 100;

    public function index(Request $request)
    {
        $this->initTenant($request);

        $query = DB::connection($this->dbName)->table('object_versions');

        if ($request->entity)    $query->where('entity', $request->entity);
        if ($request->source)    $query->where('source', $request->source);
        if ($request->batch)     $query->where('batch', $request->batch);
        if ($request->filled('user_id')) $query->where('user_id', (int) $request->user_id);
        if ($request->date_from) $query->where('created_at', '>=', $request->date_from . ' 00:00:00');
        if ($request->date_to)   $query->where('created_at', '<=', $request->date_to . ' 23:59:59');

        // Правки по закрытым должностью счетам не показываем и здесь: иначе
        // закрытый счёт читался бы через журнал
        if (!$this->scope->isEmpty()) {
            $hidden = $this->scope->hiddenIds();

            $query->where(function ($q) use ($hidden) {
                $q->where('entity', '<>', 'operation')
                  ->orWhereNotIn('entity_id', function ($sub) use ($hidden) {
                      $sub->from('operations')->select('id')
                          ->where(fn($w) => $w->whereIn('in_bi_id', $hidden)->orWhereIn('out_bi_id', $hidden));
                  });
            });
        }

        $total = (clone $query)->count();

        $perPage = min((int) ($request->per_page ?: self::PER_PAGE), 500);
        $page    = max(1, (int) ($request->page ?: 1));

        $rows = $query->orderByDesc('id')
            ->forPage($page, $perPage)
            ->get();

        // Размер пачки — чтобы одна строка могла сказать «и ещё 28 таких же»
        $batches = $rows->pluck('batch')->filter()->unique()->values();
        $sizes   = $batches->isEmpty() ? [] : DB::connection($this->dbName)
            ->table('object_versions')
            ->whereIn('batch', $batches)
            ->selectRaw('batch, count(*) c')->groupBy('batch')->pluck('c', 'batch')->all();

        $users = DB::connection($this->dbName)->table('users')->pluck('name', 'id');

        return response()->json([
            'data' => (new HistoryPresenter($this->dbName))->forRows($rows, $sizes),
            'meta' => [
                'total'    => $total,
                'page'     => $page,
                'per_page' => $perPage,
                'has_more' => $page * $perPage < $total,
            ],
            // Для выпадающих списков отбора: значения берём из самого журнала,
            // чтобы не предлагать людей и источники, которых в нём нет
            'filters' => [
                'users'   => DB::connection($this->dbName)->table('object_versions')
                    ->whereNotNull('user_id')->distinct()->pluck('user_id')
                    ->map(fn($id) => ['id' => (int) $id, 'name' => $users[$id] ?? "#$id"])->values(),
                'sources' => DB::connection($this->dbName)->table('object_versions')
                    ->distinct()->orderBy('source')->pluck('source'),
            ],
        ]);
    }
}
