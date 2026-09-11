<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Operation;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class OperationsController extends TenantController
{
    private function model(): Operation
    {
        return (new Operation)->setConnection($this->dbName);
    }

    public function index(Request $request)
    {
        $this->initTenant($request);

        $query = $this->model()->newQuery()
            ->with([
                'inBalanceItem',
                'outBalanceItem',
                'inInfo1',
                'inInfo2',
                'outInfo1',
                'outInfo2',
            ])
            ->orderByDesc('date')
            ->orderByDesc('id');

        if ($request->project_id)    $query->where('project_id', $request->project_id);
        if ($request->date_from)     $query->where('date', '>=', $request->date_from);
        if ($request->date_to)       $query->where('date', '<=', $request->date_to . ' 23:59:59');
        if ($request->in_bi_id)      $query->where('in_bi_id', $request->in_bi_id);
        if ($request->out_bi_id)     $query->where('out_bi_id', $request->out_bi_id);
        if ($request->source)        $query->where('source', $request->source);
        // Строка «0» валидна: она означает «показать только непроведённые»
        if ($request->filled('is_posted')) $query->where('is_posted', (bool) (int) $request->is_posted);
        if ($request->external_id)   $query->where('external_id', $request->external_id);
        if ($request->external_date) $query->where('external_date', $request->external_date);
        if ($request->ids)           $query->whereIn('id', array_map('intval', explode(',', $request->ids)));

        // Операция, у которой закрыты обе стороны, не показывается вовсе.
        // Оставшиеся — с одной закрытой стороной — показываются замазанными:
        // иначе у кассира не сошёлся бы остаток по расчётному счёту, деньги
        // ушли бы в никуда. Замазывание делает formatOperation
        if (!$this->scope->isEmpty()) {
            $hidden = $this->scope->hiddenIds();
            $query->where(function ($q) use ($hidden) {
                $q->whereNotIn('in_bi_id', $hidden)->orWhereNotIn('out_bi_id', $hidden);
            });
        }

        if ($request->info_id) {
            $infoId = $request->info_id;
            $query->where(function ($q) use ($infoId) {
                $q->where('in_info_1_id', $infoId)
                    ->orWhere('in_info_2_id', $infoId)
                    ->orWhere('in_info_3_id', $infoId)
                    ->orWhere('out_info_1_id', $infoId)
                    ->orWhere('out_info_2_id', $infoId)
                    ->orWhere('out_info_3_id', $infoId);
            });
        }

        if ($q = trim((string) $request->q)) {
            $this->applySearch($query, $q);
        }

        // Итоги считаем по всему отбору, а не по показанной странице.
        // Раньше «операций за период» и «сумма за период» складывались в
        // браузере из того, что приехало, — и на 201-й операции обе цифры
        // начинали тихо врать, показывая неполный период как полный
        $summary = $this->summary($query);

        $perPage = min((int) ($request->per_page ?? 50), 500);
        $page    = max((int) ($request->page ?? 1), 1);
        $items   = $query->offset(($page - 1) * $perPage)->limit($perPage)->get();

        return response()->json([
            'data'     => $items->map(fn($op) => $this->formatOperation($op)),
            'total'    => $summary['count'],
            'page'     => $page,
            'per_page' => $perPage,
            'summary'  => $summary,
        ]);
    }

    /**
     * Поиск строкой по журналу.
     *
     * Ищем там, куда человек смотрит в списке: содержание, примечание, номер,
     * сумма, счёт и аналитика. Отдельного поля под каждый реквизит не заводим —
     * в журнале ищут «Альфа-банк» или «1297,87», не зная и не желая знать, в
     * какой колонке это лежит.
     *
     * Справочники и счета отбираем заранее, отдельными запросами: шесть
     * коррелированных подзапросов на каждую строку журнала стоили бы дороже
     * двух простых выборок по маленьким таблицам.
     */
    private function applySearch($query, string $q): void
    {
        $conn = DB::connection($this->dbName);
        // Проценты и подчёркивания в запросе — литералы, а не шаблон LIKE
        $like = '%' . addcslashes($q, '%_\\') . '%';

        $infoIds = $conn->table('info')
            ->whereNull('deleted_at')
            ->where(fn($w) => $w->where('name', 'like', $like)->orWhere('inn', 'like', $like)->orWhere('code', 'like', $like))
            ->limit(1000)->pluck('id');

        $biIds = $conn->table('balance_items')
            ->whereNull('deleted_at')
            ->where(fn($w) => $w->where('name', 'like', $like)->orWhere('code', 'like', $like))
            ->limit(1000)->pluck('id')
            // Закрытый должностью счёт из поиска убираем: его название не
            // показывают, и находить по нему операции — тот же показ, окольно
            ->diff($this->scope->isEmpty() ? [] : $this->scope->hiddenIds())
            ->values();

        $query->where(function ($w) use ($q, $like, $infoIds, $biIds) {
            $w->where('content', 'like', $like)
                ->orWhere('note', 'like', $like)
                ->orWhere('external_id', 'like', $like);

            // «368» или «#368» — это номер операции в первой колонке
            if (preg_match('/^#?(\d+)$/u', $q, $m)) {
                $w->orWhere('id', (int) $m[1]);
            }

            // «1297,87», «1 297.87» — сумма. Точное совпадение: диапазон по
            // сумме — это уже фильтр, а не поиск по строке
            $num = str_replace([' ', "\u{00A0}", ','], ['', '', '.'], $q);
            if (is_numeric($num)) {
                $w->orWhere('amount', (float) $num);
            }

            if ($infoIds->isNotEmpty()) {
                foreach (['in_info_1_id', 'in_info_2_id', 'in_info_3_id',
                          'out_info_1_id', 'out_info_2_id', 'out_info_3_id'] as $col) {
                    $w->orWhereIn($col, $infoIds);
                }
            }

            if ($biIds->isNotEmpty()) {
                $w->orWhereIn('in_bi_id', $biIds)->orWhereIn('out_bi_id', $biIds);
            }
        });
    }

    /**
     * Итоги по всему отбору: количество, сумма и обороты по счетам.
     *
     * Считает база, а не браузер: список приезжает страницами, и складывать
     * показанное значило бы показывать часть периода как весь период.
     */
    private function summary($query): array
    {
        // Без eager-загрузок и без сортировки: для агрегатов они лишние,
        // а ORDER BY рядом с GROUP BY ещё и отвергается строгим режимом
        $source = $query->toBase();
        $base   = fn() => (clone $source)->reorder();

        $row = $base()->selectRaw('COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS amount')->first();

        $turnover = [];
        foreach (['in_bi_id' => 'debit', 'out_bi_id' => 'credit'] as $col => $side) {
            foreach ($base()->select($col)->selectRaw('SUM(amount) AS s')->groupBy($col)->get() as $r) {
                $turnover[$r->$col][$side] = (float) $r->s;
            }
        }

        return [
            'count'    => (int) $row->cnt,
            'amount'   => (float) $row->amount,
            'accounts' => $this->turnoverRows($turnover),
        ];
    }

    /** Обороты по счетам списком: закрытые должностью сходятся в одну строку */
    private function turnoverRows(array $turnover): array
    {
        if (!$turnover) return [];

        $items = DB::connection($this->dbName)->table('balance_items')
            ->whereIn('id', array_keys($turnover))
            ->get(['id', 'code', 'name'])->keyBy('id');

        $out = [];
        foreach ($turnover as $biId => $sides) {
            $hidden = $this->scope->hides($biId);
            $key    = $hidden ? 'hidden' : $biId;

            $out[$key] ??= [
                'bi_id'  => $hidden ? null : (int) $biId,
                'code'   => $hidden ? '' : ($items[$biId]->code ?? ''),
                'name'   => $hidden ? 'Скрыто' : ($items[$biId]->name ?? ''),
                'hidden' => $hidden,
                'debit'  => 0.0,
                'credit' => 0.0,
            ];

            $out[$key]['debit']  += $sides['debit'] ?? 0;
            $out[$key]['credit'] += $sides['credit'] ?? 0;
        }

        usort($out, fn($a, $b) => ($a['hidden'] <=> $b['hidden']) ?: strcmp($a['code'], $b['code']));

        return $out;
    }

    public function store(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'date'          => 'required|date',
            'project_id'    => 'required|integer',
            'amount'        => 'required|numeric',
            'quantity'      => 'nullable|numeric',
            'in_quantity'   => 'nullable|numeric',
            'out_quantity'  => 'nullable|numeric',
            'in_bi_id'      => 'required|integer',
            'out_bi_id'     => 'required|integer',
            'in_info_1_id'  => 'nullable|integer',
            'in_info_2_id'  => 'nullable|integer',
            'in_info_3_id'  => 'nullable|integer',
            'out_info_1_id' => 'nullable|integer',
            'out_info_2_id' => 'nullable|integer',
            'out_info_3_id' => 'nullable|integer',
            'content'       => 'nullable|string|max:1000',
            'note'          => 'nullable|string|max:1000',
            'source'        => 'nullable|string|max:50',
            'is_posted'     => 'nullable|boolean',
            'external_id'   => 'nullable|string|max:25',
            'external_date' => 'nullable|date',
        ]);

        if ($resp = $this->lockError($data['date'])) return $resp;

        if ($this->scope->hidesAny([$data['in_bi_id'], $data['out_bi_id']])) {
            return $this->hiddenAccountError();
        }

        // is_posted задаём явно, а не полагаемся на умолчание схемы: после
        // create() модель не перечитывается, и в ответе оказалось бы false,
        // хотя в базе операция проведена
        $op = $this->model()->newQuery()->create(array_merge($data, $this->quantities($data), [
            'source'    => $data['source'] ?? 'manual',
            'is_posted' => $data['is_posted'] ?? true,
        ]));

        $op->load(['inBalanceItem', 'outBalanceItem', 'inInfo1', 'inInfo2', 'outInfo1', 'outInfo2']);

        return response()->json(['data' => $this->formatOperation($op)], 201);
    }

    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        $op = $this->model()->newQuery()->findOrFail($id);

        // Замазанную операцию править нельзя: форма её не видела целиком и
        // сохранила бы то, чего человеку не показывали
        if ($this->scope->hidesAny([$op->in_bi_id, $op->out_bi_id])) {
            return $this->hiddenAccountError();
        }

        // Нельзя трогать операцию в закрытом периоде
        if ($resp = $this->lockError($op->date)) return $resp;

        // Запрет редактирования операций созданных из документов
        if ($op->table_name === 'documents' && $op->table_id) {
            return response()->json([
                'message'     => 'Операция создана из документа. Для изменений откройте документ.',
                'document_id' => (int) $op->table_id,
            ], 422);
        }

        $data = $request->validate([
            'date'          => 'required|date',
            'project_id'    => 'required|integer',
            'amount'        => 'required|numeric',
            'quantity'      => 'nullable|numeric',
            'in_quantity'   => 'nullable|numeric',
            'out_quantity'  => 'nullable|numeric',
            'in_bi_id'      => 'required|integer',
            'out_bi_id'     => 'required|integer',
            'in_info_1_id'  => 'nullable|integer',
            'in_info_2_id'  => 'nullable|integer',
            'in_info_3_id'  => 'nullable|integer',
            'out_info_1_id' => 'nullable|integer',
            'out_info_2_id' => 'nullable|integer',
            'out_info_3_id' => 'nullable|integer',
            'content'       => 'nullable|string|max:1000',
            'note'          => 'nullable|string|max:1000',
            'source'        => 'nullable|string|max:50',
            'is_posted'     => 'nullable|boolean',
            'external_id'   => 'nullable|string|max:25',
            'external_date' => 'nullable|date',
        ]);

        // Нельзя переносить операцию в закрытый период
        if ($resp = $this->lockError($data['date'])) return $resp;

        // ...и нельзя увести операцию на закрытый счёт
        if ($this->scope->hidesAny([$data['in_bi_id'], $data['out_bi_id']])) {
            return $this->hiddenAccountError();
        }

        $op->update(array_merge($data, $this->quantities($data)));
        $op->load(['inBalanceItem', 'outBalanceItem', 'inInfo1', 'inInfo2', 'outInfo1', 'outInfo2']);

        return response()->json(['data' => $this->formatOperation($op)]);
    }

    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        $op = $this->model()->newQuery()->findOrFail($id);

        if ($this->scope->hidesAny([$op->in_bi_id, $op->out_bi_id])) {
            return $this->hiddenAccountError();
        }

        // Нельзя удалять операцию в закрытом периоде
        if ($resp = $this->lockError($op->date)) return $resp;

        // Запрет удаления операций созданных из документов
        if ($op->table_name === 'documents' && $op->table_id) {
            return response()->json([
                'message'     => 'Операция создана из документа. Для удаления отмените проведение документа.',
                'document_id' => (int) $op->table_id,
            ], 422);
        }

        $op->delete();

        return response()->json(['message' => 'Операция удалена']);
    }

    /**
     * POST /operations/{id}/posting — провести или снять проведение.
     *
     * Снятая с проведения операция остаётся в списке, но исчезает из оборотов:
     * balance_changes по ней убирает триггер. Поэтому это правка учётных цифр
     * и на неё распространяется дата запрета.
     */
    public function setPosting(Request $request, int $id)
    {
        $this->initTenant($request);

        $data = $request->validate(['is_posted' => 'required|boolean']);

        $op = $this->model()->newQuery()->findOrFail($id);

        if ($this->scope->hidesAny([$op->in_bi_id, $op->out_bi_id])) {
            return $this->hiddenAccountError();
        }

        if ($resp = $this->lockError($op->date)) return $resp;

        // Проведением операций документа управляет сам документ: снимешь здесь —
        // документ останется «проведённым», а его строка перестанет считаться
        if ($op->fromDocument()) {
            return response()->json([
                'message'     => 'Операция создана из документа. Проведением управляйте через документ.',
                'document_id' => (int) $op->table_id,
            ], 422);
        }

        $op->update(['is_posted' => $data['is_posted']]);
        $op->load(['inBalanceItem', 'outBalanceItem', 'inInfo1', 'inInfo2', 'outInfo1', 'outInfo2']);

        return response()->json(['data' => $this->formatOperation($op)]);
    }

    /**
     * GET /operations/{id}/changes — движения, которые дала операция.
     *
     * balance_changes ведут триггеры, и это единственное, что видят отчёты.
     * Показать их рядом с операцией — самый прямой способ ответить на вопрос
     * «почему в оборотке такая цифра».
     */
    public function changes(Request $request, int $id)
    {
        $this->initTenant($request);

        $op = $this->model()->newQuery()->findOrFail($id);

        // Обе стороны закрыты — операции для этого человека не существует
        if ($this->scope->hides($op->in_bi_id) && $this->scope->hides($op->out_bi_id)) {
            return response()->json(['message' => 'Операция не найдена'], 404);
        }

        $rows = $this->scope->exclude(
            DB::connection($this->dbName)->table('balance_changes as bc'),
            'bc.bi_id'
        )
            ->leftJoin('balance_items as bi', 'bi.id', '=', 'bc.bi_id')
            ->leftJoin('info as i1', 'i1.id', '=', 'bc.info_1_id')
            ->leftJoin('info as i2', 'i2.id', '=', 'bc.info_2_id')
            ->leftJoin('info as i3', 'i3.id', '=', 'bc.info_3_id')
            ->where('bc.operation_id', $id)
            // У таблицы нет ключа, поэтому порядок задаём явно: дебет первым
            ->orderByRaw("bc.side = 'credit'")
            ->get([
                'bc.side', 'bc.date', 'bc.project_id', 'bc.amount', 'bc.quantity',
                'bc.bi_id', 'bi.code as bi_code', 'bi.name as bi_name',
                'bc.content',
                'i1.name as info_1_name', 'i2.name as info_2_name', 'i3.name as info_3_name',
            ]);

        return response()->json([
            'data'      => $rows,
            'is_posted' => (bool) $op->is_posted,
            'deleted'   => (bool) $op->deleted_at,
        ]);
    }

    /**
     * Количество по сторонам операции.
     *
     * В balance_changes его кладёт триггер: in_quantity — в дебетовую строку,
     * out_quantity — в кредитовую, и каждую сторону он берёт только если у её
     * счёта поднят has_quantity. Общая колонка quantity осталась от первой
     * схемы; её по-прежнему принимаем — так шлют старые вызовы, где количество
     * одно на обе стороны, — но в отчёты попадают именно сторонние.
     *
     * null трактуем как «не передали»: иначе вызов со старым полем quantity
     * обнулил бы обе стороны.
     */
    private function quantities(array $data): array
    {
        $legacy = (float) ($data['quantity'] ?? 0);
        $in     = (float) ($data['in_quantity']  ?? $legacy);
        $out    = (float) ($data['out_quantity'] ?? $legacy);

        return [
            'in_quantity'  => $in,
            'out_quantity' => $out,
            // Легаси-колонку держим равной той стороне, где количество есть:
            // на неё смотрит расшифровка и копирование старых операций
            'quantity'     => $in ?: $out,
        ];
    }

    /**
     * Замазать закрытую сторону операции.
     *
     * Счёт и аналитика уходят вместе: «Иванов И. И.» рядом с суммой рассказывает
     * ровно то, что мы прячем. Имя подменяем на «Скрыто», а не оставляем пустым, —
     * так любое место, где строку просто выводят, скажет правду само.
     */
    private function maskSide(array $out, string $prefix): array
    {
        $out[$prefix . '_bi_id']   = null;
        $out[$prefix . '_bi_code'] = null;
        $out[$prefix . '_bi_name'] = 'Скрыто';
        $out[$prefix . '_hidden']  = true;

        foreach ([1, 2, 3] as $n) {
            $out[$prefix . "_info_{$n}_id"]   = null;
            $out[$prefix . "_info_{$n}_name"] = null;
            $out[$prefix . "_info_{$n}_type"] = null;
        }

        return $out;
    }

    private function formatOperation(Operation $op): array
    {
        $out = [
            'id'              => $op->id,
            // Отдаём «настенное» время без метки пояса.
            //
            // Carbon сериализуется в ISO с суффиксом Z, и браузер честно
            // считал такую строку временем UTC: список сдвигал операцию на
            // смещение пояса (22:59 показывались как 01:59 следующего дня),
            // а форма брала строку как есть — одна операция выглядела
            // по-разному в двух местах. Дата операции хранится, фильтруется
            // и сравнивается с датой запрета как локальная, поэтому и наружу
            // уходит локальной. Формат «...T...» без пояса JS разбирает как
            // местное время по стандарту, в отличие от строки с пробелом.
            'date'            => $op->date?->format('Y-m-d\TH:i:s'),
            'amount'          => $op->amount,
            'quantity'        => $op->quantity,
            'in_quantity'     => (float) $op->in_quantity,
            'out_quantity'    => (float) $op->out_quantity,
            'content'         => $op->content,
            'note'            => $op->note,
            'source'          => $op->source,
            'is_posted'       => (bool) $op->is_posted,
            'table_name'      => $op->table_name,   // ← добавлено: для определения источника
            'table_id'        => $op->table_id,     // ← добавлено: ID документа-источника
            'external_id'     => $op->external_id,
            'external_date'   => $op->external_date?->format('Y-m-d'),
            'project_id'      => $op->project_id,
            'in_bi_id'        => $op->in_bi_id,
            'in_bi_code'      => $op->inBalanceItem?->code,
            'in_bi_name'      => $op->inBalanceItem?->name,
            'in_info_1_type'  => $op->inBalanceItem?->info_1_type,
            'in_info_2_type'  => $op->inBalanceItem?->info_2_type,
            'out_bi_id'       => $op->out_bi_id,
            'out_bi_code'     => $op->outBalanceItem?->code,
            'out_bi_name'     => $op->outBalanceItem?->name,
            'out_info_1_type' => $op->outBalanceItem?->info_1_type,
            'out_info_2_type' => $op->outBalanceItem?->info_2_type,
            'in_info_1_id'    => $op->in_info_1_id,
            'in_info_1_name'  => $op->inInfo1?->name,
            'in_info_2_id'    => $op->in_info_2_id,
            'in_info_2_name'  => $op->inInfo2?->name,
            'out_info_1_id'   => $op->out_info_1_id,
            'out_info_1_name' => $op->outInfo1?->name,
            'out_info_2_id'   => $op->out_info_2_id,
            'out_info_2_name' => $op->outInfo2?->name,
            'in_hidden'       => false,
            'out_hidden'      => false,
            'created_at'      => $op->created_at,
        ];

        if ($this->scope->isEmpty()) return $out;

        if ($this->scope->hides($op->in_bi_id))  $out = $this->maskSide($out, 'in');
        if ($this->scope->hides($op->out_bi_id)) $out = $this->maskSide($out, 'out');

        return $out;
    }
}
