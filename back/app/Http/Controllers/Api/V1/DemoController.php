<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Demo\DemoDatasets;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;

/**
 * Заполнение чистой компании демо-данными.
 *
 * Нужно для показа: регистрируешь компанию и за минуту получаешь базу, в
 * которой есть что открыть — год операций, долги, бюджеты, отчёты. Руками такое
 * не наберёшь, а показывать пустые экраны бессмысленно.
 *
 * Кнопки в меню нет намеренно: это инструмент показа, а не работы, и место ему
 * не рядом с ежедневными разделами. Вызывается из интерфейса скрытым приёмом,
 * см. DemoSeeder на фронте.
 *
 * Права — раздела «Архивная копия»: по весу это то же самое, что восстановление
 * из файла, то есть вся база компании разом.
 */
class DemoController extends TenantController
{
    /** GET /demo/datasets — что можно залить и можно ли сейчас */
    public function datasets(Request $request)
    {
        $this->initTenant($request);

        $occupied = DemoDatasets::occupied($this->dbName);

        return response()->json([
            'data'     => array_values(DemoDatasets::all()),
            'can_seed' => $occupied === [],
            'occupied' => $occupied,
            'reason'   => $occupied === [] ? null
                : 'В базе уже есть данные (' . DemoDatasets::describe($occupied)
                  . '). Демо-данные заливаются только в чистую компанию — '
                  . 'иначе в одной базе окажутся два разных учёта.',
        ]);
    }

    /** POST /demo/seed — залить выбранный набор */
    public function seed(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate(['dataset' => 'required|string']);

        $set = DemoDatasets::find($data['dataset']);

        if (!$set)                      return $this->fail('Такого набора демо-данных нет');
        if (!$set['ready'] || !$set['command']) {
            return $this->fail('Набор «' . $set['name'] . '» ещё не готов — он появится позже');
        }

        $occupied = DemoDatasets::occupied($this->dbName);
        if ($occupied) {
            return $this->fail('Заполнить можно только чистую компанию. Сейчас в базе — '
                . DemoDatasets::describe($occupied));
        }

        // Генератор заводит тысячи записей и в типовой лимит запроса не
        // укладывается. Прерванный на середине прогон оставил бы половину
        // компании, поэтому время снимаем явно
        @set_time_limit(0);
        @ignore_user_abort(true);

        $started = microtime(true);

        Artisan::call($set['command'], ['tenant' => $this->tenantId]);

        return response()->json([
            'ok'      => true,
            'dataset' => $set['key'],
            'name'    => $set['name'],
            'seconds' => round(microtime(true) - $started, 1),
            'counts'  => DemoDatasets::occupied($this->dbName),
            'output'  => trim(Artisan::output()),
        ]);
    }

    private function fail(string $message)
    {
        return response()->json(['message' => $message], 422);
    }
}
