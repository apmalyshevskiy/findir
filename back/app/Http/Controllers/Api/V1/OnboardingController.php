<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Первые шаги новой компании.
 *
 * Состояние шагов не хранится, а считается по данным: «внесите первую операцию»
 * отмечено, когда операция и правда есть. Хранимая галочка «я это сделал» врала
 * бы ровно там, где важнее всего не врать, — у человека, который нажал её, не
 * разобравшись. Заодно нет ни миграции, ни сброса состояния при переносе базы.
 *
 * Отсюда же и отсутствие шага «прочитайте справку»: проверить его нечем.
 */
class OnboardingController extends TenantController
{
    public function index(Request $request)
    {
        $this->initTenant($request);

        $conn = DB::connection($this->dbName);

        $info = fn(?string $type) => $conn->table('info')
            ->whereNull('deleted_at')
            ->when($type, fn($q) => $q->where('type', $type))
            ->exists();

        $operations = fn(?string $source) => $conn->table('operations')
            ->whereNull('deleted_at')
            ->when($source, fn($q) => $q->where('source', $source))
            ->exists();

        // Порядок — тот, в котором за шаги берутся: без справочников некуда
        // класть операции, без операций нечего смотреть в отчётах
        $steps = [
            [
                'key'   => 'dictionaries',
                'title' => 'Заполнить справочники',
                'hint'  => 'Статьи, контрагенты, кассы. При создании компании они пустые: набор зависит от вашего дела',
                'link'  => '/info',
                'done'  => $info(null),
            ],
            [
                'key'   => 'cash',
                'title' => 'Завести кассы и расчётные счета',
                'hint'  => 'Без них деньгам негде лежать',
                'link'  => '/info',
                'done'  => $info('cash'),
            ],
            [
                'key'   => 'operations',
                'title' => 'Внести первую операцию',
                'hint'  => 'Руками, диктовкой ИИ-помощнику или загрузкой выписки',
                'link'  => '/operations',
                'done'  => $operations(null),
            ],
            [
                'key'   => 'statement',
                'title' => 'Загрузить банковскую выписку',
                'hint'  => 'Самый быстрый способ наполнить учёт фактом за прошлые месяцы',
                'link'  => '/bank-statement',
                'done'  => $operations('bank_import'),
            ],
            [
                'key'   => 'users',
                'title' => 'Позвать коллег',
                'hint'  => 'Должность решает, какие разделы и счета человек увидит',
                'link'  => '/users',
                // Пользователей не удаляют мягко — считаем как есть
                'done'  => $conn->table('users')->count() > 1,
            ],
            [
                'key'   => 'budget',
                'title' => 'Составить бюджет',
                'hint'  => 'Когда факт накопился, появляется с чем сравнивать план',
                'link'  => '/budget',
                'done'  => $conn->table('budget_documents')->exists(),
            ],
        ];

        return response()->json(['data' => [
            'steps' => $steps,
            'done'  => count(array_filter(array_column($steps, 'done'))),
            'total' => count($steps),
        ]]);
    }
}
