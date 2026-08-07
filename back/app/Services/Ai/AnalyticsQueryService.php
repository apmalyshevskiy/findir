<?php

namespace App\Services\Ai;

use Illuminate\Support\Facades\DB;

/**
 * Расчёт показателей по запросу из диалога с ИИ.
 *
 * Модель НЕ считает и НЕ пишет SQL — она возвращает только описание выборки
 * (период, счёт, сторона, разрез). Считает сервер по balance_changes — той же
 * таблице, из которой строится оборотка, поэтому цифры в диалоге и в отчётах
 * совпадают по определению.
 *
 * Так же, как с операциями: модель называет счёт кодом, сервер сам находит id.
 * Придумать число модель физически не может — оно приходит из базы.
 */
final class AnalyticsQueryService
{
    /** Сколько строк разреза отдаём максимум (остальное сворачиваем в «прочее»). */
    private const MAX_ROWS = 30;

    /** Предел точек у ряда во времени — дальше укрупняем шаг, а не режем данные. */
    private const MAX_POINTS = 400;

    /** Разрезы по времени — от мелкого к крупному, порядок важен для укрупнения. */
    public const TIME_GROUPINGS = ['day', 'week', 'month', 'quarter', 'year'];

    public const ANALYTIC_TYPES = ['partner', 'employee', 'department', 'cash',
                                   'flow', 'expenses', 'product', 'revenue'];

    public const GROUPINGS = ['day', 'week', 'month', 'quarter', 'year',
                              'account', 'partner', 'employee', 'department',
                              'cash', 'flow', 'expenses', 'product', 'revenue'];

    public const CHARTS = ['bar', 'line', 'donut'];

    /**
     * @param  array $spec  ['title','date_from','date_to','account_code','side','group_by']
     * @return array|null   null — спецификация непригодна (нет периода и т.п.)
     */
    public function run(string $db, array $spec, $accounts): ?array
    {
        $from = $this->dateOrNull($spec['date_from'] ?? null);
        $to   = $this->dateOrNull($spec['date_to'] ?? null);
        if (!$from || !$to) return null;              // без периода показатель бессмысленен

        $side    = in_array($spec['side'] ?? null, ['debit', 'credit', 'net'], true) ? $spec['side'] : 'net';
        $groupBy = in_array($spec['group_by'] ?? null, self::GROUPINGS, true) ? $spec['group_by'] : null;

        $code = trim((string) ($spec['account_code'] ?? ''));
        $acc  = $code !== '' ? $this->findAccount($accounts, $code) : null;
        if ($code !== '' && !$acc) return null;        // счёт не опознан — не гадаем

        $isTime = $groupBy && in_array($groupBy, self::TIME_GROUPINGS, true);

        // Разрез по аналитике возможен только внутри счёта: слот аналитики
        // (info_1..3) у каждого счёта свой, без счёта поле не определить
        $analyticGroup = $groupBy && !$isTime && $groupBy !== 'account';
        if ($analyticGroup && !$acc) $groupBy = null;

        // Отбор по конкретному элементу справочника («расходы на эквайринг»).
        // Не разрешился — честно возвращаем ошибку: показать вместо этого
        // сумму по всему счёту под заголовком «расходы на эквайринг» хуже, чем
        // не показать ничего.
        $filter = $this->resolveFilter($db, $spec['filter'] ?? null, $acc);
        if ($filter && isset($filter['error'])) {
            return [
                'title'     => trim((string) ($spec['title'] ?? '')) ?: 'Показатель',
                'date_from' => $from,
                'date_to'   => $to,
                'error'     => $filter['error'],
                'rows'      => [],
            ];
        }

        $q = DB::connection($db)->table('balance_changes')
            ->whereBetween('date', [$from . ' 00:00:00', $to . ' 23:59:59']);

        if ($acc) $q->where('bi_id', $acc->id);
        if ($filter) $q->whereIn($filter['slot'], $filter['ids']);

        $amount = $this->amountExpr($side);

        // ── Итог ──────────────────────────────────────────────────────────────
        $totalRow = (clone $q)
            ->selectRaw("$amount AS total, COUNT(DISTINCT operation_id) AS cnt")
            ->first();

        $total = (float) ($totalRow->total ?? 0);
        $count = (int)   ($totalRow->cnt   ?? 0);

        // ── Разрез ────────────────────────────────────────────────────────────
        $rows = [];
        if ($isTime) {
            // Слишком мелкий шаг на длинном периоде даёт нечитаемый ряд —
            // укрупняем (дни → недели → месяцы), а не обрезаем данные
            $groupBy = $this->fitGranularity($groupBy, $from, $to);
            [$expr, $label] = $this->timeGrouping($groupBy);
            $rows = $this->groupByExpr($q, $expr, $amount, $label, true);
        } elseif ($groupBy === 'account') {
            $byId = $accounts->keyBy('id');
            $rows = $this->groupByExpr($q, 'bi_id', $amount, function ($k) use ($byId) {
                $a = $byId->get((int) $k);
                return $a ? "{$a->code} {$a->name}" : 'Счёт #' . $k;
            });
        } elseif ($analyticGroup) {
            $slot = $this->slotFor($acc, $groupBy);
            if ($slot) {
                $names = DB::connection($db)->table('info')->pluck('name', 'id');
                $rows = $this->groupByExpr($q, $slot, $amount,
                    fn($k) => $k ? ($names[(int) $k] ?? 'Элемент #' . $k) : 'Без аналитики');
            } else {
                $groupBy = null;   // у счёта нет такой аналитики
            }
        }

        return [
            'title'      => trim((string) ($spec['title'] ?? '')) ?: 'Показатель',
            'date_from'  => $from,
            'date_to'    => $to,
            'side'       => $side,
            'group_by'   => $groupBy,
            'chart'      => $this->chartFor($spec['chart'] ?? null, $groupBy, $rows),
            'account'    => $acc ? ['code' => $acc->code, 'name' => $acc->name] : null,
            'filter'     => $filter ? ['type' => $filter['type'], 'name' => $filter['name']] : null,
            'error'      => null,
            'total'      => round($total, 2),
            'operations' => $count,
            'rows'       => $rows,
        ];
    }

    // ── Внутреннее ────────────────────────────────────────────────────────────

    /**
     * В balance_changes дебет — это amount > 0, кредит — amount < 0
     * (так же считает оборотка).
     */
    private function amountExpr(string $side): string
    {
        return match ($side) {
            'debit'  => 'SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)',
            'credit' => 'SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END)',
            default  => 'SUM(amount)',
        };
    }

    /**
     * Шаг ряда, при котором точек не больше MAX_POINTS.
     * «Выручка по дням за три года» превращается в «по месяцам» — данные все,
     * читаемость сохранена. Фактический шаг возвращается клиенту в group_by,
     * так что подмена видна.
     */
    private function fitGranularity(string $groupBy, string $from, string $to): string
    {
        $days = max(1, (strtotime($to) - strtotime($from)) / 86400 + 1);
        $per  = ['day' => 1, 'week' => 7, 'month' => 30, 'quarter' => 91, 'year' => 365];

        $i = array_search($groupBy, self::TIME_GROUPINGS, true);
        while ($i < count(self::TIME_GROUPINGS) - 1
            && $days / $per[self::TIME_GROUPINGS[$i]] > self::MAX_POINTS) {
            $i++;
        }

        return self::TIME_GROUPINGS[$i];
    }

    /** SQL-выражение группировки и подпись точки для каждого шага времени. */
    private function timeGrouping(string $groupBy): array
    {
        return match ($groupBy) {
            // Ключ недели — понедельник: подпись «29.06 — 05.07» понятнее номера недели
            'week' => [
                'DATE(DATE_SUB(date, INTERVAL WEEKDAY(date) DAY))',
                function ($k) {
                    $mon = strtotime((string) $k);
                    return date('d.m', $mon) . ' — ' . date('d.m', $mon + 6 * 86400);
                },
            ],
            'month'   => ["DATE_FORMAT(date, '%Y-%m')", fn($k) => $this->monthName((string) $k)],
            'quarter' => [
                "CONCAT(YEAR(date), '-', QUARTER(date))",
                function ($k) {
                    [$y, $q] = array_pad(explode('-', (string) $k), 2, 1);
                    return ['', 'I', 'II', 'III', 'IV'][(int) $q] . " кв. $y";
                },
            ],
            'year'    => ['YEAR(date)', fn($k) => (string) $k],
            // Год в подписи дня не нужен — период показан в шапке карточки
            default   => ['DATE(date)', fn($k) => date('d.m', strtotime((string) $k))],
        };
    }

    private function groupByExpr($q, string $expr, string $amount, callable $label, bool $isTime = false): array
    {
        $raw = (clone $q)
            ->selectRaw("$expr AS grp, $amount AS total, COUNT(DISTINCT operation_id) AS cnt")
            ->groupByRaw($expr)
            ->get();

        $rows = $raw->map(fn($r) => [
            'key'        => (string) $r->grp,
            'name'       => $label($r->grp),
            'amount'     => round((float) $r->total, 2),
            'operations' => (int) $r->cnt,
        ])->filter(fn($r) => abs($r['amount']) > 0.004)->values();

        // Время — по хронологии: сортируем по ключу (ГГГГ-ММ-ДД, ГГГГ-ММ…), а не
        // по подписи, иначе «Август» встанет перед «Июлем» по алфавиту.
        // Категории — по убыванию суммы: сверху то, что весит больше.
        $rows = $isTime
            ? $rows->sortBy('key')->values()
            : $rows->sortByDesc(fn($r) => abs($r['amount']))->values();

        $rows = $rows->map(function ($r) { unset($r['key']); return $r; });

        // «Прочее» уместно только для категорий: в ряду по времени такая свёртка
        // склеила бы разные даты в одну бессмысленную точку. Длину ряда
        // ограничивает укрупнение шага (fitGranularity), а не обрезка.
        if (!$isTime && $rows->count() > self::MAX_ROWS) {
            $head = $rows->take(self::MAX_ROWS);
            $tail = $rows->skip(self::MAX_ROWS);
            $head->push([
                'name'       => 'Прочее (' . $tail->count() . ')',
                'amount'     => round($tail->sum('amount'), 2),
                'operations' => $tail->sum('operations'),
            ]);
            $rows = $head;
        }

        return $rows->all();
    }

    /**
     * Какой график уместен. Выбор модели уважаем, но проверяем по данным:
     *  - рисовать нечего без разреза;
     *  - кольцо (доли) невозможно, если знаки разные — доля от суммы, в которой
     *    плюсы гасят минусы, вводит в заблуждение;
     *  - одна точка линией не рисуется.
     * Модель не указала вид — берём разумный по разрезу.
     */
    private function chartFor(?string $want, ?string $groupBy, array $rows): ?string
    {
        if (!$groupBy || count($rows) < 2) return null;

        $isTime = in_array($groupBy, self::TIME_GROUPINGS, true);
        $chart  = in_array($want, self::CHARTS, true) ? $want : ($isTime ? 'line' : 'bar');

        // Доли во времени не считают: ряд показывает динамику, а не структуру
        if ($isTime && $chart === 'donut') $chart = 'line';

        $signs = array_unique(array_map(fn($r) => $r['amount'] >= 0 ? 1 : -1, $rows));
        if ($chart === 'donut' && count($signs) > 1) $chart = 'bar';

        return $chart;
    }

    /**
     * Отбор по элементу справочника: тип + название → слот счёта + список id.
     *
     * Как и везде в ИИ-слое, модель называет элемент словами, id находит сервер.
     * Группа берётся вместе с потомками — «Банковские услуги» должны включать
     * входящие в них статьи, иначе цифра разойдётся с оборотно-сальдовой.
     *
     * @return array|null  ['slot','ids','type','name'] | ['error'] | null (отбора нет)
     */
    private function resolveFilter(string $db, $raw, $acc): ?array
    {
        if (!is_array($raw)) return null;

        $type = trim((string) ($raw['type'] ?? ''));
        $name = trim((string) ($raw['name'] ?? ''));
        if ($type === '' || $name === '') return null;

        if (!in_array($type, self::ANALYTIC_TYPES, true)) {
            return ['error' => "Неизвестный вид аналитики «{$type}»"];
        }
        if (!$acc) {
            return ['error' => 'Чтобы отобрать по аналитике, нужно указать счёт'];
        }

        $slot = $this->slotFor($acc, $type);
        if (!$slot) {
            return ['error' => "У счёта {$acc->code} нет аналитики этого вида — отобрать по «{$name}» нельзя"];
        }

        $items = DB::connection($db)->table('info')
            ->where('type', $type)->whereNull('deleted_at')
            ->get(['id', 'name', 'parent_id']);

        $found = $this->matchByName($items, $name);
        if (!$found) {
            $where = [
                'partner' => 'контрагентов', 'employee' => 'сотрудников', 'department' => 'отделов',
                'cash' => 'касс и счетов', 'flow' => 'статей ДДС', 'expenses' => 'статей расходов',
                'product' => 'товаров и услуг', 'revenue' => 'статей доходов',
            ][$type] ?? 'аналитик';

            return ['error' => "Не нашёл «{$name}» среди {$where} — проверьте название"];
        }

        return [
            'slot' => $slot,
            'ids'  => array_merge([$found->id], $this->descendantIds($items, $found->id)),
            'type' => $type,
            'name' => $found->name,
        ];
    }

    /** Точное совпадение, затем вхождение подстроки. Регистр не важен. */
    private function matchByName($items, string $name)
    {
        $needle = mb_strtolower($name);

        foreach ($items as $i) {
            if (mb_strtolower($i->name) === $needle) return $i;
        }
        foreach ($items as $i) {
            if (str_contains(mb_strtolower($i->name), $needle)) return $i;
        }
        return null;
    }

    /** Все потомки элемента справочника (группа считается вместе с содержимым). */
    private function descendantIds($items, int $parentId): array
    {
        $ids = [];
        foreach ($items as $i) {
            if ((int) $i->parent_id === $parentId) {
                $ids[] = $i->id;
                $ids = array_merge($ids, $this->descendantIds($items, (int) $i->id));
            }
        }
        return $ids;
    }

    /** Поле info_N_id, в котором у этого счёта лежит аналитика нужного типа. */
    private function slotFor($acc, string $type): ?string
    {
        foreach ([1, 2, 3] as $n) {
            if (($acc->{"info_{$n}_type"} ?? null) === $type) return "info_{$n}_id";
        }
        return null;
    }

    /** Поиск счёта по коду — терпим к латинским двойникам кириллических букв. */
    private function findAccount($accounts, ?string $code)
    {
        if (!$code) return null;
        $needle = mb_strtoupper(trim($code));

        foreach ($accounts as $a) {
            if (mb_strtoupper($a->code) === $needle) return $a;
        }
        // Латиница вместо кириллицы: A100 вместо А100
        $map = ['A' => 'А', 'B' => 'В', 'C' => 'С', 'E' => 'Е', 'H' => 'Н', 'K' => 'К',
                'M' => 'М', 'O' => 'О', 'P' => 'П', 'T' => 'Т', 'X' => 'Х', 'Y' => 'У'];
        $fixed = strtr($needle, $map);
        foreach ($accounts as $a) {
            if (mb_strtoupper($a->code) === $fixed) return $a;
        }
        return null;
    }

    private function dateOrNull(?string $d): ?string
    {
        if (!$d) return null;
        $d = trim($d);
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) ? $d : null;
    }

    private function monthName(string $ym): string
    {
        [$y, $m] = array_map('intval', explode('-', $ym) + [1 => 0]);
        $names = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
        return ($names[$m] ?? $ym) . ' ' . $y;
    }
}
