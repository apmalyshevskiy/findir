<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/**
 * Автосопоставление строк банковской выписки:
 *  1. Контрагент (info.type=partner) — по ИНН, затем по названию
 *  2. Статья ДДС (info.type=flow)   — по ключевым словам в НазначениеПлатежа
 */
class BankStatementMatcher
{
    private string $dbName;

    /** @var array<string, object> ИНН → info запись */
    private array $partnersByInn  = [];

    /** @var array<int, object> id → info запись */
    private array $partnersById   = [];

    /** @var array<int, object> id → flow запись */
    private array $flowItems      = [];

    /** @var array<string, int|null> Кэш поиска по названию */
    private array $nameCache      = [];

    /** @var array<string, object> category → строка category_postings */
    private array $postings       = [];

    /** @var array<string, int> code → balance_items.id (счёт по коду) */
    private array $biIdByCode     = [];

    /** @var array<int, object> правила классификации тенанта, отсортированы по priority DESC */
    private array $rules          = [];

    public function __construct(string $dbName)
    {
        $this->dbName = $dbName;
        $this->loadDictionaries();
    }

    /**
     * Обогатить массив строк из парсера результатами автосопоставления.
     * Добавляет поля: suggested_partner_id, suggested_flow_id, existing_operation_ids
     */
    public function matchRows(array $rows, string $ourAccountNumber): array
    {
        return array_map(fn($row) => $this->matchRow($row), $rows);
    }

    /**
     * Найти существующие операции по списку пар [external_id, external_date].
     * Возвращает map: "external_id|external_date" => [operation_id, ...]
     */
    public function findExistingOperations(array $rows): array
    {
        if (empty($rows)) return [];

        $pairs = collect($rows)
            ->filter(fn($r) => $r['external_id'] && $r['external_date'])
            ->map(fn($r) => ['id' => $r['external_id'], 'date' => $r['external_date']])
            ->unique(fn($r) => $r['id'] . '|' . $r['date'])
            ->values()
            ->toArray();

        if (empty($pairs)) return [];

        // Строим WHERE (external_id=? AND external_date=?) OR ...
        $placeholders = implode(' OR ', array_fill(0, count($pairs), '(external_id = ? AND external_date = ?)'));
        $bindings = [];
        foreach ($pairs as $p) {
            $bindings[] = $p['id'];
            $bindings[] = $p['date'];
        }

        $existing = DB::connection($this->dbName)
            ->table('operations')
            ->whereNull('deleted_at')
            ->where('source', 'bank_import')
            ->whereRaw("($placeholders)", $bindings)
            ->select('id', 'external_id', 'external_date', 'amount')
            ->get();

        // Группируем по ключу "external_id|external_date"
        $map = [];
        foreach ($existing as $op) {
            $key = $op->external_id . '|' . $op->external_date;
            $map[$key][] = $op->id;
        }

        return $map;
    }

    // ── Приватные методы ──────────────────────────────────────────────────────

    private function matchRow(array $row): array
    {
        // ── Ступень 1: классификация (сигнал → категория) ──
        $category = $this->classify($row);
        $row['suggested_category'] = $category;

        // ── Ступень 2: разноска (категория → счёт + статья + контрагент) ──
        // Если для категории есть строка в карте разноски — берём оттуда.
        if ($category !== PaymentCategory::OTHER && isset($this->postings[$category])) {
            return $this->applyPosting($row, $this->postings[$category]);
        }

        // ── Fallback (OTHER или категория без настроенной разноски) ──
        // Прежнее поведение: keyword-флоу + партнёр по ИНН. Ничего не ломаем.
        $row['suggested_partner_id'] = $this->matchPartner(
            $row['counterparty_inn'] ?? null,
            $row['counterparty_raw'] ?? null
        );
        $row['suggested_flow_id'] = $this->matchFlow(
            $row['purpose_raw'] ?? null,
            $row['direction']   ?? 'out'
        );

        return $row;
    }

    /**
     * Ступень 1 — отнести строку к категории.
     *
     * Порядок:
     *  1. Универсальные определённости в коде (верны для всех тенантов, не
     *     требуют разметки): перевод между своими по ИНН==ИНН.
     *  2. Правила тенанта из payment_classification_rules по убыванию priority,
     *     первое совпадение побеждает. Наполняются пользователем.
     *  3. OTHER — не распознано, дальше пойдёт прежний fallback (keyword+партнёр).
     */
    private function classify(array $row): string
    {
        // 1. Универсальные определённости (в коде)
        if (!empty($row['is_self_transfer'])) {
            return PaymentCategory::TRANSFER;
        }

        // 2. Правила тенанта (из таблицы, по приоритету)
        foreach ($this->rules as $rule) {
            if ($this->ruleMatches($rule, $row)) {
                return $rule->category;
            }
        }

        // 3. Не распознано
        return PaymentCategory::OTHER;
    }

    /**
     * Проверить, совпадает ли правило со строкой. Все ЗАДАННЫЕ условия — по AND.
     * Пустое условие не проверяется.
     */
    private function ruleMatches(object $rule, array $row): bool
    {
        // direction
        if (($rule->direction ?? 'any') !== 'any') {
            if (($row['direction'] ?? null) !== $rule->direction) {
                return false;
            }
        }

        // inn (точное совпадение)
        if (!empty($rule->inn)) {
            $cpInn = isset($row['counterparty_inn']) ? trim((string) $row['counterparty_inn']) : '';
            if ($cpInn === '' || $cpInn !== trim((string) $rule->inn)) {
                return false;
            }
        }

        // purpose_keywords (contains, любая подстрока совпала)
        if (!empty($rule->purpose_keywords)) {
            $purpose = mb_strtolower((string) ($row['purpose_raw'] ?? ''));
            if ($purpose === '') {
                return false;
            }
            $keywords = array_filter(array_map(
                fn($k) => mb_strtolower(trim($k)),
                explode('|', $rule->purpose_keywords)
            ));
            $hit = false;
            foreach ($keywords as $kw) {
                if ($kw !== '' && mb_strpos($purpose, $kw) !== false) {
                    $hit = true;
                    break;
                }
            }
            if (!$hit) {
                return false;
            }
        }

        // has_kbk (для TAX, шаг 3): требуем заполненный КБК/статус
        if ($rule->has_kbk !== null) {
            $rowHasKbk = !empty($row['has_kbk']);
            if ((bool) $rule->has_kbk !== $rowHasKbk) {
                return false;
            }
        }

        // amount_min / amount_max
        $amount = isset($row['amount']) ? (float) $row['amount'] : null;
        if ($rule->amount_min !== null && ($amount === null || $amount < (float) $rule->amount_min)) {
            return false;
        }
        if ($rule->amount_max !== null && ($amount === null || $amount > (float) $rule->amount_max)) {
            return false;
        }

        return true;
    }

    /**
     * Ступень 2 — проставить счёт/статью/контрагента по карте разноски.
     * Заполняет suggested_* поля, которые читает фронт.
     */
    private function applyPosting(array $row, object $posting): array
    {
        // Корр-счёт по коду (коды плана счетов общие для всех тенантов)
        $row['suggested_counter_bi_id'] = $posting->counter_account_code
            ? ($this->biIdByCode[$posting->counter_account_code] ?? null)
            : null;

        // Статья ДДС: дефолт из карты разноски.
        // (на шаге 3 здесь появится уточнение статьи по назначению для TAX)
        $row['suggested_flow_id'] = $posting->flow_info_id ? (int) $posting->flow_info_id : null;

        // Контрагент
        $row['suggested_partner_id'] = ($posting->partner_mode === 'from_inn')
            ? $this->matchPartner($row['counterparty_inn'] ?? null, $row['counterparty_raw'] ?? null)
            : null;

        return $row;
    }

    private function matchPartner(?string $inn, ?string $name): ?int
    {
        // Шаг 1: по ИНН (точное совпадение, confidence=95)
        if ($inn && trim($inn) !== '') {
            $inn = trim($inn);
            if (isset($this->partnersByInn[$inn])) {
                return (int) $this->partnersByInn[$inn]->id;
            }
        }

        // Шаг 2: нечёткий поиск по названию (confidence=60)
        if ($name && trim($name) !== '') {
            return $this->matchPartnerByName(trim($name));
        }

        return null;
    }

    private function matchPartnerByName(string $name): ?int
    {
        $key = mb_strtolower($name);

        if (array_key_exists($key, $this->nameCache)) {
            return $this->nameCache[$key];
        }

        // Нормализуем: убираем кавычки, организационно-правовые формы
        $normalized = $this->normalizeName($name);

        $bestId    = null;
        $bestScore = 0;

        foreach ($this->partnersById as $partner) {
            $pNorm = $this->normalizeName($partner->name);
            // Простое: содержит ли одно другое
            if (mb_stripos($pNorm, $normalized) !== false ||
                mb_stripos($normalized, $pNorm) !== false) {
                $score = min(mb_strlen($normalized), mb_strlen($pNorm));
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestId    = (int) $partner->id;
                }
            }
        }

        $this->nameCache[$key] = $bestId;
        return $bestId;
    }

    private function matchFlow(?string $purpose, string $direction): ?int
    {
        if (!$purpose) return null;

        $p = mb_strtolower($purpose);

        $rules = $this->getFlowRules($direction);

        foreach ($rules as [$keywords, $code]) {
            foreach ($keywords as $kw) {
                if (mb_strpos($p, $kw) !== false) {
                    return $this->findFlowIdByCode($code);
                }
            }
        }

        return null;
    }

    /**
     * Правила сопоставления: [[keywords], flow_code]
     * Порядок важен — первое совпадение побеждает.
     */
    private function getFlowRules(string $direction): array
    {
        if ($direction === 'in') {
            return [
                [['возврат', 'возврщ'],                              'OD-IN-OTH'],
                [['поступлени', 'оплата от', 'выручк'],              'OD-IN-CUST'],
            ];
        }

        // direction === 'out'
        return [
            [['аренд'],                                              'OD-OUT-RNT'],
            [['зарплат', 'заработн', 'отпускн', ' зп ', 'выплат зп', 'перечислен зп'], 'OD-OUT-ZP'],
            [['налог', 'ндс', 'ндфл', 'страхов', 'пфр', 'фсс'],    'OD-OUT-ZP'],  // налоги с ФОТ
            [['комисси', 'за прием', 'банковск обслуж'],             'OD-OUT-ADM'],
            [['реклам', 'маркетинг'],                                'OD-OUT-COM'],
            [['материал', 'закупк', 'товар', 'сырьё', 'сырье'],     'OD-OUT-MAT'],
            [['перемещени', 'перевод средств между', 'между счетами', 'между своими'], 'OD-TRF'],
        ];
    }

    private function findFlowIdByCode(string $code): ?int
    {
        foreach ($this->flowItems as $item) {
            if ($item->code === $code) {
                return (int) $item->id;
            }
        }
        return null;
    }

    private function normalizeName(string $name): string
    {
        // Убираем организационно-правовые формы и кавычки
        $name = preg_replace('/ООО|ОАО|ПАО|АО|ЗАО|ИП|ГУП|МУП|НКО/ui', '', $name);
        $name = str_replace(['"', "'", '«', '»', '„', '"'], '', $name);
        $name = preg_replace('/\s+/', ' ', $name);
        return trim(mb_strtolower($name));
    }

    private function loadDictionaries(): void
    {
        // Загружаем партнёров
        $partners = DB::connection($this->dbName)
            ->table('info')
            ->where('type', 'partner')
            ->where('is_active', true)
            ->whereNull('deleted_at')
            ->select('id', 'name', 'inn')
            ->get();

        foreach ($partners as $p) {
            $this->partnersById[(int) $p->id] = $p;
            if ($p->inn && trim($p->inn) !== '') {
                $this->partnersByInn[trim($p->inn)] = $p;
            }
        }

        // Загружаем статьи flow
        $flows = DB::connection($this->dbName)
            ->table('info')
            ->where('type', 'flow')
            ->where('is_active', true)
            ->whereNull('deleted_at')
            ->select('id', 'name', 'code')
            ->get();

        foreach ($flows as $f) {
            $this->flowItems[(int) $f->id] = $f;
        }

        // План счетов: code → id (счёт по коду, коды общие для всех тенантов)
        $bis = DB::connection($this->dbName)
            ->table('balance_items')
            ->select('id', 'code')
            ->get();

        foreach ($bis as $bi) {
            if ($bi->code !== null && $bi->code !== '') {
                $this->biIdByCode[$bi->code] = (int) $bi->id;
            }
        }

        // Карта разноски: category → строка (ступень 2). Таблица может ещё
        // не существовать на тенантах, где миграция не прогнана — тогда
        // конвейер просто работает по fallback-пути, без разноски.
        try {
            $postings = DB::connection($this->dbName)
                ->table('category_postings')
                ->where('is_active', true)
                ->get();

            foreach ($postings as $p) {
                $this->postings[$p->category] = $p;
            }
        } catch (\Throwable $e) {
            $this->postings = [];
        }

        // Правила классификации тенанта (ступень 1). Таблица может ещё не
        // существовать — тогда работают только универсальные правила в коде.
        // Сортируем по priority DESC: первое совпадение при проходе побеждает.
        try {
            $this->rules = DB::connection($this->dbName)
                ->table('payment_classification_rules')
                ->where('is_active', true)
                ->orderByDesc('priority')
                ->orderBy('id')
                ->get()
                ->all();
        } catch (\Throwable $e) {
            $this->rules = [];
        }
    }
}
