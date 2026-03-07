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
            [['перемещени', 'перевод между'],                        'OD-TRF'],
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
    }
}
