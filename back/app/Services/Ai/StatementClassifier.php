<?php

namespace App\Services\Ai;

use Illuminate\Support\Facades\DB;

/**
 * ИИ-доработка банковской выписки.
 *
 * Работает ПОСЛЕ BankStatementMatcher и только по строкам, которые правила не
 * распознали (category = OTHER). Возвращает те же поля suggested_*, что и
 * матчер, — фронт не отличает источник подсказки.
 *
 * Дополнительно предлагает правила классификации: подтверждённое правило
 * закрывает такой случай навсегда бесплатно и детерминированно.
 */
class StatementClassifier
{
    /**
     * Размер пачки. Ограничение не по цене (она копеечная), а по времени:
     * модель отдаёт ~20 токенов/с, 5 строк ≈ 29 с. Больше 20 строк за раз
     * упрётся в таймаут — фронт шлёт выписку частями.
     */
    private const MAX_ROWS = 20;

    public function __construct(private RouterAiClient $ai) {}

    public function classify(string $db, array $rows, ?string $model = null): array
    {
        $rows = array_slice(array_values($rows), 0, self::MAX_ROWS);
        if (!$rows) return ['rows' => [], 'rules' => [], 'usage' => []];

        $postings  = $this->postings($db);
        $flows     = $this->dict($db, 'flow');
        $expenses  = $this->dict($db, 'expenses');
        $partners  = $this->dict($db, 'partner');
        $biByCode  = $this->accountsByCode($db);
        $flowExp   = $this->flowExpenseMap($db);
        $rulesNow  = $this->existingRules($db);

        $result = $this->ai->json(
            [
                ['role' => 'system', 'content' => $this->prompt($postings, $flows, $expenses, $rulesNow)],
                ['role' => 'user',   'content' => $this->rowsText($rows)],
            ],
            $this->schema(array_keys($postings)),
            $model
        );

        $out = [];
        foreach (($result['rows'] ?? []) as $r) {
            $i = (int) ($r['index'] ?? -1);
            if (!isset($rows[$i])) continue;
            $out[$i] = $this->toSuggestion($r, $rows[$i], $postings, $flows, $expenses, $partners, $biByCode, $flowExp);
        }

        return [
            'rows'  => $out,
            'rules' => $this->ruleProposals($result['rules'] ?? [], array_keys($postings), $rulesNow),
            'usage' => $result['_usage'] ?? [],
        ];
    }

    /** Ответ модели по строке → те же поля suggested_*, что отдаёт матчер. */
    private function toSuggestion(array $r, array $row, array $postings, array $flows, array $expenses, array $partners, array $biByCode, array $flowExp): array
    {
        $category = (string) ($r['category'] ?? 'OTHER');
        // Модель иногда возвращает мусор (видели -1) — зажимаем в [0,1]
        $conf = max(0.0, min(1.0, (float) ($r['confidence'] ?? 0)));
        $s = ['suggested_category' => $category, 'ai_confidence' => $conf];
        if (!empty($r['comment'])) $s['ai_comment'] = $r['comment'];

        // Категория известна — раскладываем ровно как правила (та же карта разноски)
        $p = $postings[$category] ?? null;
        if ($p) {
            $s['suggested_counter_bi_id'] = $p->counter_account_code ? ($biByCode[$p->counter_account_code] ?? null) : null;
            $s['suggested_flow_id']       = $p->flow_info_id ? (int) $p->flow_info_id : null;
            $s['suggested_partner_id']    = $p->partner_mode === 'from_inn'
                ? $this->matchPartner($partners, $row['counterparty_inn'] ?? null, $row['counterparty_raw'] ?? null)
                : null;
        }

        // Статья ДДС в карте разноски — это ДЕФОЛТ категории (для SUPPLIER_PAYMENT он
        // один на всё). Уточнение по назначению платежа — как раз то, ради чего
        // зовут ИИ: «аренда помещения» точнее, чем «закупка материалов».
        // Поэтому уверенный ответ модели имеет приоритет над дефолтом категории.
        $aiFlow = !empty($r['flow']) ? $this->byName($flows, $r['flow']) : null;
        if ($aiFlow && (empty($s['suggested_flow_id']) || $conf >= 0.7)) {
            $s['suggested_flow_id'] = $aiFlow;
        }
        if (empty($s['suggested_partner_id']) && !empty($r['partner'])) {
            $s['suggested_partner_id'] = $this->byName($partners, $r['partner']);
        }

        // Статья расхода: связь статьи ДДС имеет приоритет над догадкой модели
        $s['suggested_expense_id'] = (!empty($s['suggested_flow_id']) && isset($flowExp[$s['suggested_flow_id']]))
            ? $flowExp[$s['suggested_flow_id']]
            : (!empty($r['expense']) ? $this->byName($expenses, $r['expense']) : null);

        return $s;
    }

    /** Предложения правил: отсекаем несуществующие категории и дубли. */
    private function ruleProposals(array $rules, array $categories, array $existing): array
    {
        $out = [];
        foreach ($rules as $r) {
            $cat = (string) ($r['category'] ?? '');
            if (!in_array($cat, $categories, true)) continue;

            $dir  = in_array($r['direction'] ?? '', ['in', 'out', 'any'], true) ? $r['direction'] : 'any';
            $inn  = trim((string) ($r['inn'] ?? '')) ?: null;
            $kw   = trim((string) ($r['purpose_keywords'] ?? '')) ?: null;
            if (!$inn && !$kw) continue;                       // правило без условий — опасно

            $key = mb_strtolower($dir . '|' . $inn . '|' . $kw . '|' . $cat);
            if (isset($existing[$key]) || isset($out[$key])) continue;   // уже есть

            $out[$key] = [
                'direction'        => $dir,
                'inn'              => $inn,
                'purpose_keywords' => $kw,
                'category'         => $cat,
                'reason'           => (string) ($r['reason'] ?? ''),
            ];
        }
        return array_values($out);
    }

    // ── Промпт и схема ────────────────────────────────────────────────────────

    private function prompt(array $postings, array $flows, array $expenses, array $existing): string
    {
        $cats = [];
        foreach ($postings as $c => $p) {
            $cats[] = "- {$c}: счёт {$p->counter_account_code}"
                . ($p->flow_info_id ? ", статья ДДС по умолчанию задана" : "")
                . ($p->partner_mode === 'from_inn' ? ", контрагент по ИНН" : "");
        }
        $flowList = implode('; ', array_slice(array_values($flows), 0, 60));
        $expList  = implode('; ', array_slice(array_values($expenses), 0, 60));
        $rulesTxt = $existing ? implode("\n", array_map(fn($r) => "- {$r}", array_slice(array_keys($existing), 0, 40))) : '—';

        return <<<TXT
Ты — бухгалтер, разбираешь строки банковской выписки, которые не покрылись правилами.

КАТЕГОРИИ (используй ТОЛЬКО их; если не подходит ни одна — OTHER):
{$this->join($cats)}

СТАТЬИ ДДС: {$flowList}

СТАТЬИ РАСХОДОВ: {$expList}

УЖЕ НАСТРОЕННЫЕ ПРАВИЛА (направление|ИНН|ключевые слова|категория):
{$rulesTxt}

ЗАДАЧА:
1. Для КАЖДОЙ строки верни category (из списка), при необходимости flow (статья ДДС)
   и expense (статья расхода) — ТОЧНЫМИ названиями из списков выше, иначе null.
   partner — название контрагента из назначения платежа, если оно там есть, иначе null.
2. confidence: 1.0 — однозначно; ниже 0.6 — сомнительно, человек проверит.
3. index — порядковый номер строки из запроса, не переставляй и не пропускай строки.
4. Ориентируйся на направление (in/out), ИНН и назначение платежа.
   Поступления от клиентов — доход; комиссии банка, эквайринг, налоги, аренда — расход.

ПРАВИЛА (rules):
5. Если видишь повторяющийся признак, по которому такие платежи можно распознавать
   автоматически, — предложи правило: direction, inn (если признак — ИНН),
   purpose_keywords (устойчивая подстрока из назначения; несколько — через « | »),
   category, reason (зачем).
6. НЕ предлагай правила, которые уже есть в списке выше, и не делай правил без условий.
   Ключевые слова бери максимально устойчивые: без номеров документов, дат и сумм.
TXT;
    }

    private function join(array $a): string { return implode("\n", $a); }

    /** Компактное представление строк — экономим токены. */
    private function rowsText(array $rows): string
    {
        $lines = [];
        foreach ($rows as $i => $r) {
            $lines[] = sprintf(
                "[%d] %s %s | контрагент: %s | ИНН: %s | назначение: %s",
                $i,
                ($r['direction'] ?? '') === 'in' ? 'ПРИХОД' : 'РАСХОД',
                number_format((float) ($r['amount'] ?? 0), 2, '.', ' '),
                mb_substr((string) ($r['counterparty_raw'] ?? '—'), 0, 60),
                $r['counterparty_inn'] ?? '—',
                mb_substr(preg_replace('/\s+/u', ' ', (string) ($r['purpose_raw'] ?? '')), 0, 220)
            );
        }
        return "Строки выписки:\n" . implode("\n", $lines);
    }

    private function schema(array $categories): array
    {
        return [
            'type' => 'object',
            'additionalProperties' => false,
            'required' => ['rows', 'rules'],
            'properties' => [
                'rows' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'additionalProperties' => false,
                        'required' => ['index', 'category', 'flow', 'expense', 'partner', 'confidence', 'comment'],
                        'properties' => [
                            'index'      => ['type' => 'integer'],
                            'category'   => ['type' => 'string'],
                            'flow'       => ['type' => ['string', 'null']],
                            'expense'    => ['type' => ['string', 'null']],
                            'partner'    => ['type' => ['string', 'null']],
                            'confidence' => ['type' => 'number'],
                            'comment'    => ['type' => ['string', 'null']],
                        ],
                    ],
                ],
                'rules' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'additionalProperties' => false,
                        'required' => ['direction', 'inn', 'purpose_keywords', 'category', 'reason'],
                        'properties' => [
                            'direction'        => ['type' => 'string', 'enum' => ['in', 'out', 'any']],
                            'inn'              => ['type' => ['string', 'null']],
                            'purpose_keywords' => ['type' => ['string', 'null']],
                            'category'         => ['type' => 'string', 'enum' => $categories ?: ['OTHER']],
                            'reason'           => ['type' => 'string'],
                        ],
                    ],
                ],
            ],
        ];
    }

    // ── Справочники тенанта ───────────────────────────────────────────────────

    private function postings(string $db): array
    {
        $rows = DB::connection($db)->table('category_postings')->where('is_active', true)->get();
        $out = [];
        foreach ($rows as $r) $out[$r->category] = $r;
        return $out;
    }

    private function dict(string $db, string $type): array
    {
        return DB::connection($db)->table('info')->where('type', $type)
            ->whereNull('deleted_at')->where('is_active', true)
            ->pluck('name', 'id')->all();
    }

    private function accountsByCode(string $db): array
    {
        return DB::connection($db)->table('balance_items')->whereNull('deleted_at')
            ->pluck('id', 'code')->all();
    }

    private function flowExpenseMap(string $db): array
    {
        return DB::connection($db)->table('info')->where('type', 'flow')
            ->whereNotNull('default_expense_id')->whereNull('deleted_at')
            ->pluck('default_expense_id', 'id')->map(fn($v) => (int) $v)->all();
    }

    /** Ключ «направление|инн|ключевые слова|категория» → правило (для отсева дублей). */
    private function existingRules(string $db): array
    {
        $out = [];
        foreach (DB::connection($db)->table('payment_classification_rules')->where('is_active', true)->get() as $r) {
            $key = mb_strtolower(($r->direction ?: 'any') . '|' . $r->inn . '|' . $r->purpose_keywords . '|' . $r->category);
            $out[$key] = $r;
        }
        return $out;
    }

    // ── Сопоставление названий ────────────────────────────────────────────────

    private function byName(array $items, ?string $name): ?int
    {
        if (!$name) return null;
        $n = $this->norm($name);
        foreach ($items as $id => $v) if ($this->norm($v) === $n) return (int) $id;
        foreach ($items as $id => $v) {
            $x = $this->norm($v);
            if ($x !== '' && (str_contains($x, $n) || str_contains($n, $x))) return (int) $id;
        }
        return null;
    }

    private function matchPartner(array $partners, ?string $inn, ?string $name): ?int
    {
        return $this->byName($partners, $name);   // по ИНН партнёра ищет сам матчер
    }

    private function norm(string $s): string
    {
        return trim(preg_replace('/\s+/u', ' ', mb_strtolower($s)));
    }
}
