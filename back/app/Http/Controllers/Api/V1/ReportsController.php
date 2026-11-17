<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\BalanceItem;
use App\Services\AnalyticSlots;
use App\Services\ChartOfAccounts;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Отчёты для разговора с собственником: баланс и движение денег.
 *
 * Оба считаются по тому же регистру, что и оборотка, — `balance_changes`, где
 * сумма знаковая: сальдо это SUM(amount) на дату, обороты различаются полем
 * `side`. Ничего нового не считаем, меняется только форма.
 *
 * Почему это отдельные отчёты, а не разрезы оборотки: ОСВ отвечает на вопрос
 * «что на счетах», её читает учётчик. Баланс и ОДДС отвечают «чем компания
 * владеет и откуда взялись деньги» — их читает тот, кто принимает решения, и
 * ему нужны разделы и итоги, а не план счетов.
 */
class ReportsController extends TenantController
{
    /**
     * Управленческий баланс на дату.
     *
     * Баланс сходится сам, и это свойство регистра, а не расчёта: операция
     * кладёт +X на одну сторону и −X на другую, поэтому сумма по всем счетам
     * всегда ноль. Пассивы хранятся отрицательными — при показе переворачиваем.
     *
     * Единственное, что может его разбалансировать, — закрытые должностью
     * счета: часть строк не видна, и тогда мы говорим об этом прямо, а не
     * показываем расхождение молча.
     */
    public function balance(Request $request)
    {
        $this->initTenant($request);

        $date    = $request->date ?: date('Y-m-d');
        $compare = $request->compare_date ?: null;
        $project = $request->project_id ? (int) $request->project_id : null;

        $accounts = $this->scope
            ->exclude((new BalanceItem)->setConnection($this->dbName)->newQuery(), 'id')
            ->orderBy('code')->get();

        $now  = $this->saldoAt($date, $project);
        $was  = $compare ? $this->saldoAt($compare, $project) : [];

        // Расчёты с контрагентами и сотрудниками показываем развёрнуто: по
        // одним поставщикам мы должны, другим переплатили. Свёрнутое сальдо
        // «Поставщики −4 млн» в пассиве не читается — переплата это наш актив,
        // а аванс покупателя — наш долг. Так устроен любой настоящий баланс
        $settle = $accounts->filter(fn ($a) => in_array($a->info_1_type, ['partner', 'employee'], true)
            && in_array($this->balanceGroup($a), [ChartOfAccounts::ASSETS, ChartOfAccounts::LIABILITIES], true))
            ->pluck('id')->all();
        $nowParts = $this->settlementParts($settle, $date, $project);
        $wasParts = $compare ? $this->settlementParts($settle, $compare, $project) : [];

        // Раскладываем счета по разделам каталога
        $rows = ['assets' => [], 'liabilities' => [], 'capital' => [], 'profit' => []];

        foreach ($accounts as $account) {
            $group   = $this->balanceGroup($account);
            $catalog = ChartOfAccounts::byCode((string) $account->code);
            $hint    = $catalog['hint'] ?? null;
            $opening = $this->isOpeningBalance($account);

            $base = [
                'bi_id' => (int) $account->id,
                'code'  => $account->code,
                'name'  => $opening ? 'Капитал на начало учёта' : $account->name,
                'hint'  => $opening
                    ? 'Остатки, введённые при старте учёта: имущество минус долги на тот день. Это собственные средства, с которыми компания пришла в учёт.'
                    : $hint,
            ];

            if (in_array((int) $account->id, $settle, true)) {
                // Дебет — нам должны (актив), кредит — должны мы (пассив)
                $dNow = $nowParts[$account->id]['debit'] ?? 0.0;
                $cNow = $nowParts[$account->id]['credit'] ?? 0.0;
                $dWas = $wasParts[$account->id]['debit'] ?? 0.0;
                $cWas = $wasParts[$account->id]['credit'] ?? 0.0;
                $isAsset = $group === ChartOfAccounts::ASSETS;

                $main = $isAsset ? [$dNow, $dWas] : [-$cNow, -$cWas];
                $flip = $isAsset ? [-$cNow, -$cWas] : [$dNow, $dWas];

                if (abs($main[0]) >= 0.005 || abs($main[1]) >= 0.005) {
                    $rows[$group][] = $base + ['amount' => round($main[0], 2), 'compare_amount' => round($main[1], 2)];
                }
                if (abs($flip[0]) >= 0.005 || abs($flip[1]) >= 0.005) {
                    $rows[$isAsset ? 'liabilities' : 'assets'][] = array_merge($base, [
                        'name'           => $account->name,
                        'note'           => $isAsset ? 'должны мы' : 'должны нам',
                        'hint'           => $isAsset
                            ? 'Авансы и переплаты: эти контрагенты заплатили нам больше, чем получили. Пока не отгрузим — это наш долг.'
                            : 'Авансы и переплаты: мы заплатили этим контрагентам больше, чем получили от них. Это наш актив — они нам должны.',
                        'amount'         => round($flip[0], 2),
                        'compare_amount' => round($flip[1], 2),
                    ]);
                }
                continue;
            }

            $amount  = (float) ($now[$account->id] ?? 0);
            $compareAmount = (float) ($was[$account->id] ?? 0);

            // Пустые счета в балансе не показываем: их в плане счетов десятки,
            // а строка с нулями ничего не сообщает. Счёт, который обнулился за
            // период, остаётся — по нему видно движение
            if (abs($amount) < 0.005 && abs($compareAmount) < 0.005) continue;

            // Пассив хранится со знаком минус — показываем как положительный
            $sign = $group === ChartOfAccounts::ASSETS ? 1 : -1;
            $row  = $base + [
                'amount'         => round($amount * $sign, 2),
                'compare_amount' => round($compareAmount * $sign, 2),
            ];

            // Отрицательный остаток имущества или долга не бывает в жизни —
            // почти всегда это ошибка учёта: списали раньше, чем оприходовали
            if (in_array($group, [ChartOfAccounts::ASSETS, ChartOfAccounts::LIABILITIES], true) && $row['amount'] <= -0.005) {
                $row['warning'] = $group === ChartOfAccounts::ASSETS
                    ? 'Отрицательный остаток: списано больше, чем поступило. Скорее всего, не внесён приход — проверьте операции по счёту.'
                    : 'Отрицательный долг: погашено больше, чем было получено. Проверьте операции по счёту.';
            }

            $rows[$group][] = $row;
        }

        $sum = fn(array $list) => round(array_sum(array_column($list, 'amount')), 2);
        $sumCompare = fn(array $list) => round(array_sum(array_column($list, 'compare_amount')), 2);

        // Прибыль — не строка плана счетов, а результат: доходы минус
        // себестоимость и расходы накопленным итогом. В регистре он лежит на
        // счетах П587–П589, но собственнику нужна одна строка в капитале
        $profit = [
            'bi_id'          => null,
            'code'           => '',
            'name'           => 'Прибыль накопленным итогом',
            'amount'         => $sum($rows['profit']),
            'compare_amount' => $sumCompare($rows['profit']),
            'children'       => $rows['profit'],
        ];

        $capital = $rows['capital'];
        if ($rows['profit']) $capital[] = $profit;

        $assetsTotal = $sum($rows['assets']);
        $passiveTotal = round($sum($rows['liabilities']) + $sum($capital), 2);

        return response()->json([
            'at'         => $date,
            'compare_at' => $compare,
            'sections'   => [
                ['key' => 'assets',      'label' => 'Активы',       'side' => 'assets',
                 'rows' => $rows['assets'], 'total' => $assetsTotal,
                 'compare_total' => $sumCompare($rows['assets'])],
                ['key' => 'liabilities', 'label' => 'Обязательства', 'side' => 'passive',
                 'rows' => $rows['liabilities'], 'total' => $sum($rows['liabilities']),
                 'compare_total' => $sumCompare($rows['liabilities'])],
                ['key' => 'capital',     'label' => 'Капитал',       'side' => 'passive',
                 'rows' => $capital, 'total' => $sum($capital),
                 'compare_total' => $sumCompare($capital)],
            ],
            'totals' => [
                'assets'          => $assetsTotal,
                'passive'         => $passiveTotal,
                'assets_compare'  => $sumCompare($rows['assets']),
                'passive_compare' => round($sumCompare($rows['liabilities']) + $sumCompare($capital), 2),
            ],
            // Ноль — сошлось. Ненулевое бывает только при закрытых счетах, и
            // фронт объясняет это словами
            'check'   => round($assetsTotal - $passiveTotal, 2),
            'partial' => !$this->scope->isEmpty(),
        ]);
    }

    /**
     * ОДДС прямым методом: откуда деньги пришли и куда ушли за период.
     *
     * Считаем по денежным счетам — тем, где объявлен слот под справочник
     * «Касса/Счёт». Статья ДДС берётся из своего слота того же счёта: у А100
     * это второй слот, но полагаться на номер нельзя, счёт мог объявить иначе.
     */
    public function cashFlow(Request $request)
    {
        $this->initTenant($request);

        $from    = $request->date_from ?: date('Y-m-01');
        $to      = $request->date_to   ?: date('Y-m-t');
        $project = $request->project_id ? (int) $request->project_id : null;

        $accounts = $this->scope
            ->exclude((new BalanceItem)->setConnection($this->dbName)->newQuery(), 'id')
            ->orderBy('code')->get();

        // Денежные счета. Проверяем не код, а объявление: если человек завёл
        // свой счёт для денег, он объявит в нём кассы, и отчёт его подхватит
        $cash = $accounts->filter(fn($a) => str_starts_with((string) $a->code, 'А')
            && AnalyticSlots::slotFor($a, 'cash') !== null);

        if ($cash->isEmpty()) {
            return response()->json([
                'from' => $from, 'to' => $to,
                'sections' => [], 'cash_bi_ids' => [],
                'opening' => 0, 'closing' => 0, 'net' => 0,
                'message' => 'Не нашлось ни одного денежного счёта: у счёта должен быть слот аналитики «Касса/Счёт»',
            ]);
        }

        $cashIds = $cash->pluck('id')->map(fn($id) => (int) $id)->all();

        $opening = $this->cashTotal($cashIds, $from, $project);
        $closing = $this->cashTotal($cashIds, $to, $project, true);

        // Поле статьи ДДС у каждого денежного счёта — своё
        $flowField = [];
        foreach ($cash as $a) {
            $slot = AnalyticSlots::slotFor($a, 'flow');
            $flowField[(int) $a->id] = $slot ? "info_{$slot}_id" : null;
        }

        $rows = DB::connection($this->dbName)->table('balance_changes as bc')
            ->join('operations as o', 'o.id', '=', 'bc.operation_id')
            ->whereIn('bc.bi_id', $cashIds)
            ->where('bc.date', '>=', $from)
            ->where('bc.date', '<=', $to . ' 23:59:59')
            ->when($project, fn($q) => $q->where('bc.project_id', $project))
            // Перевод между своими кассами — не движение денег компании, а их
            // перекладывание. Без этого фильтра он раздувал бы и поступления,
            // и выплаты на одну и ту же сумму
            ->where(function ($q) use ($cashIds) {
                $q->whereNotIn('o.in_bi_id', $cashIds)->orWhereNotIn('o.out_bi_id', $cashIds);
            })
            ->selectRaw('bc.bi_id, bc.info_1_id, bc.info_2_id, bc.info_3_id, bc.side, SUM(bc.amount) total')
            ->groupBy('bc.bi_id', 'bc.info_1_id', 'bc.info_2_id', 'bc.info_3_id', 'bc.side')
            ->get();

        // Сводим по статье: приход — дебет, расход — кредит (он отрицательный,
        // разворачиваем, чтобы в отчёте стояли положительные суммы)
        $byFlow = [];
        foreach ($rows as $row) {
            $field  = $flowField[(int) $row->bi_id] ?? null;
            $flowId = $field ? (int) ($row->{$field} ?? 0) : 0;

            $byFlow[$flowId] ??= ['in' => 0.0, 'out' => 0.0];

            if ($row->side === 'debit') $byFlow[$flowId]['in']  += (float) $row->total;
            else                        $byFlow[$flowId]['out'] += -(float) $row->total;
        }

        return response()->json([
            'from'        => $from,
            'to'          => $to,
            'opening'     => round($opening, 2),
            'closing'     => round($closing, 2),
            'net'         => round($closing - $opening, 2),
            'sections'    => $this->flowSections($byFlow),
            'cash_bi_ids' => $cashIds,
            'partial'     => !$this->scope->isEmpty(),
        ]);
    }

    // ── Внутреннее ───────────────────────────────────────────────────────────

    /**
     * Раздел баланса для счёта.
     *
     * По каталогу; счёт, заведённый руками, — по первой букве кода. Счёт ввода
     * остатков (заводят руками, обычно «ВВ») — капитал: его сальдо — это
     * имущество минус долги на старте учёта, то есть собственные средства.
     */
    private function balanceGroup($account): string
    {
        if ($this->isOpeningBalance($account)) return ChartOfAccounts::CAPITAL;

        $group = ChartOfAccounts::byCode((string) $account->code)['group'] ?? null;
        if ($group) return $group;

        return str_starts_with((string) $account->code, 'А')
            ? ChartOfAccounts::ASSETS
            : ChartOfAccounts::LIABILITIES;
    }

    private function isOpeningBalance($account): bool
    {
        $code = mb_strtoupper(trim((string) $account->code));
        $name = mb_strtoupper((string) $account->name);
        return $code === 'ВВ' || str_contains($name, 'ВВОД ОСТАТК');
    }

    /**
     * Развёрнутое сальдо расчётных счетов на дату: по каждому контрагенту
     * отдельно, затем дебетовые остатки складываются в «нам должны», кредитовые
     * — в «должны мы». bi_id => ['debit' => +, 'credit' => −]
     */
    private function settlementParts(array $biIds, string $date, ?int $project): array
    {
        if (!$biIds) return [];

        $rows = $this->scope
            ->exclude(DB::connection($this->dbName)->table('balance_changes'))
            ->whereIn('bi_id', $biIds)
            ->where('date', '<=', $date . ' 23:59:59')
            ->when($project, fn($q) => $q->where('project_id', $project))
            ->selectRaw('bi_id, info_1_id, SUM(amount) total')
            ->groupBy('bi_id', 'info_1_id')
            ->get();

        $out = [];
        foreach ($rows as $r) {
            $v = (float) $r->total;
            $key = $v > 0 ? 'debit' : 'credit';
            $out[$r->bi_id][$key] = ($out[$r->bi_id][$key] ?? 0.0) + $v;
        }
        return $out;
    }


    /** Сальдо всех счетов на дату: bi_id => сумма */
    private function saldoAt(string $date, ?int $project): array
    {
        return $this->scope
            ->exclude(DB::connection($this->dbName)->table('balance_changes'))
            ->where('date', '<=', $date . ' 23:59:59')
            ->when($project, fn($q) => $q->where('project_id', $project))
            ->selectRaw('bi_id, SUM(amount) total')
            ->groupBy('bi_id')
            ->pluck('total', 'bi_id')
            ->map(fn($v) => (float) $v)
            ->all();
    }

    /**
     * Остаток денег на дату.
     *
     * `$include = false` — строго до даты (остаток на начало периода),
     * `true` — по дату включительно (остаток на конец).
     */
    private function cashTotal(array $cashIds, string $date, ?int $project, bool $include = false): float
    {
        return (float) $this->scope
            ->exclude(DB::connection($this->dbName)->table('balance_changes'))
            ->whereIn('bi_id', $cashIds)
            ->where('date', $include ? '<=' : '<', $include ? $date . ' 23:59:59' : $date)
            ->when($project, fn($q) => $q->where('project_id', $project))
            ->sum('amount');
    }

    /**
     * Три раздела ОДДС плюс неразнесённое.
     *
     * Раздел статье даёт её собственный вид, а не родительский: у «Прочего»
     * могут быть и операционные дети, и финансовые. Родитель, которому в этом
     * разделе не место, остаётся подпоркой ради вложенности — его собственную
     * сумму раздел не считает (то же правило и тем же способом, что у расходов
     * в БДР: BudgetController::expenseBucket).
     */
    private function flowSections(array $byFlow): array
    {
        $info = DB::connection($this->dbName)->table('info')
            ->where('type', 'flow')->whereNull('deleted_at')
            ->orderBy('sort_order')->orderBy('name')
            ->get(['id', 'parent_id', 'name', 'flow_kind']);

        $tree = $this->flowTree($info, null, $byFlow);

        $labels = [
            'operating' => 'Операционная деятельность',
            'investing' => 'Инвестиционная деятельность',
            'financing' => 'Финансовая деятельность',
        ];

        $out = [];
        foreach ($labels as $kind => $label) {
            $items = $this->flowBucket($tree, $kind);
            if (!$items) continue;

            $out[] = [
                'key'   => $kind,
                'label' => $label,
                'rows'  => $items,
                'in'    => round($this->sumTree($items, 'in'), 2),
                'out'   => round($this->sumTree($items, 'out'), 2),
                'net'   => round($this->sumTree($items, 'in') - $this->sumTree($items, 'out'), 2),
            ];
        }

        // Движение по деньгам без статьи ДДС. Прятать его нельзя: без этой
        // строки остаток на конец не сойдётся, и отчёт станет неправдой
        $blank = $byFlow[0] ?? null;
        if ($blank && (abs($blank['in']) >= 0.005 || abs($blank['out']) >= 0.005)) {
            $out[] = [
                'key'   => 'unclassified',
                'label' => 'Без статьи ДДС',
                'rows'  => [[
                    'id' => 0, 'name' => 'Без статьи ДДС', 'kind' => null, 'unassigned' => true,
                    'in' => round($blank['in'], 2), 'out' => round($blank['out'], 2),
                    'net' => round($blank['in'] - $blank['out'], 2),
                    'sub_in' => round($blank['in'], 2), 'sub_out' => round($blank['out'], 2),
                    'sub_net' => round($blank['in'] - $blank['out'], 2),
                ]],
                'in'  => round($blank['in'], 2),
                'out' => round($blank['out'], 2),
                'net' => round($blank['in'] - $blank['out'], 2),
            ];
        }

        return $out;
    }

    /** Дерево статей ДДС: у каждого узла собственные суммы, дети отдельно */
    private function flowTree($info, $parentId, array $byFlow): array
    {
        $out = [];

        foreach ($info as $item) {
            if ($item->parent_id != $parentId) continue;

            $children = $this->flowTree($info, $item->id, $byFlow);
            $own      = $byFlow[(int) $item->id] ?? ['in' => 0.0, 'out' => 0.0];

            $node = [
                'id'   => (int) $item->id,
                'name' => $item->name,
                'kind' => $item->flow_kind ?: 'operating',
                'in'   => $own['in'],
                'out'  => $own['out'],
            ];

            if ($children) $node['children'] = $children;

            // Пустые ветки в отчёт не идут: справочник заводят с запасом
            $hasMoney = abs($node['in']) >= 0.005 || abs($node['out']) >= 0.005 || $children;
            if ($hasMoney) $out[] = $node;
        }

        return $out;
    }

    /** Часть дерева одного вида деятельности; чужие родители — подпорками */
    private function flowBucket(array $nodes, string $kind): array
    {
        $out = [];

        foreach ($nodes as $node) {
            $children = $this->flowBucket($node['children'] ?? [], $kind);
            $mine     = ($node['kind'] ?? 'operating') === $kind;

            if (!$mine && !$children) continue;

            $node['scaffold'] = !$mine;
            if ($node['scaffold']) { $node['in'] = 0.0; $node['out'] = 0.0; }

            unset($node['children']);
            if ($children) $node['children'] = $children;

            $node['net'] = round($node['in'] - $node['out'], 2);
            $node['in']  = round($node['in'], 2);
            $node['out'] = round($node['out'], 2);

            // Свёрнутая строка должна показывать итог ветки, иначе у родителя
            // стоял бы ноль, пока его не раскроют
            $node['sub_in']  = round($node['in']  + $this->sumTree($children, 'in'), 2);
            $node['sub_out'] = round($node['out'] + $this->sumTree($children, 'out'), 2);
            $node['sub_net'] = round($node['sub_in'] - $node['sub_out'], 2);

            $out[] = $node;
        }

        return $out;
    }

    /** Сумма по всему поддереву: собственные суммы узлов, подпорки уже нулевые */
    private function sumTree(array $nodes, string $key): float
    {
        $total = 0.0;
        foreach ($nodes as $node) {
            $total += (float) ($node[$key] ?? 0);
            $total += $this->sumTree($node['children'] ?? [], $key);
        }

        return $total;
    }
}
