<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\DictionaryTemplates;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Шаблоны наполнения справочников («Заполнить» в разделе «Справочники»).
 *
 * Регистрация справочники не создаёт — тенант выбирает шаблон сам.
 * Применение идемпотентно, существующие записи не трогаются.
 */
class DictionaryTemplatesController extends TenantController
{
    /** Список шаблонов + сколько записей уже есть у тенанта. */
    public function index(Request $request)
    {
        $this->initTenant($request);

        $current = DB::connection($this->dbName)->table('info')
            ->whereNull('deleted_at')
            ->selectRaw('type, COUNT(*) c')
            ->groupBy('type')
            ->pluck('c', 'type');

        return response()->json([
            'data'    => DictionaryTemplates::all(),
            'current' => [
                'total'  => (int) $current->sum(),
                'counts' => $current,
            ],
        ]);
    }

    /** Состав шаблона с пометкой «уже есть» — для предпросмотра перед заполнением. */
    public function show(Request $request, string $key)
    {
        $this->initTenant($request);

        $tpl = DictionaryTemplates::preview($key, $this->dbName);
        if (!$tpl) {
            return response()->json(['message' => 'Шаблон не найден'], 404);
        }

        return response()->json(['data' => $tpl]);
    }

    public function apply(Request $request, string $key)
    {
        $this->initTenant($request);

        if (!DictionaryTemplates::load($key)) {
            return response()->json(['message' => 'Шаблон не найден'], 404);
        }

        $result = DictionaryTemplates::apply($key, $this->dbName);

        return response()->json([
            'message' => $result['created'] > 0
                ? "Добавлено записей: {$result['created']}"
                : 'Все записи шаблона уже есть в справочниках',
            'result'  => $result,
        ]);
    }
}
