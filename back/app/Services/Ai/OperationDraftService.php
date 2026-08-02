<?php

namespace App\Services\Ai;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Разбор свободного текста («заплатил 5000 за аренду с расчётного счёта»)
 * в ЧЕРНОВИК проводки.
 *
 * Принцип: модель оперирует человеческими понятиями (код счёта, название
 * статьи/контрагента) и НЕ придумывает id. Сопоставление названий с
 * элементами справочников тенанта и раскладку по слотам info_1/info_2
 * делает сервер — это исключает выдуманные ссылки.
 */
class OperationDraftService
{
    /** Типы аналитик, которые модель может назвать словами. */
    private const ANALYTIC_TYPES = ['cash', 'flow', 'partner', 'revenue', 'expenses', 'product', 'employee', 'department'];

    public function __construct(private RouterAiClient $ai) {}

    /**
     * @param array $history Предыдущие реплики диалога: [['role'=>'user|assistant','content'=>...]]
     */
    public function parse(string $db, string $text, ?string $model = null, array $history = []): array
    {
        $accounts = DB::connection($db)->table('balance_items')
            ->orderBy('code')->get(['id', 'code', 'name', 'info_1_type', 'info_2_type']);

        $projects = DB::connection($db)->table('projects')
            ->whereNull('deleted_at')->orderBy('id')->get(['id', 'name']);

        $dicts = $this->dictionaries($db);

        $messages = [['role' => 'system', 'content' => $this->systemPrompt($accounts, $dicts, $projects)]];
        foreach ($history as $h) {
            $role = ($h['role'] ?? '') === 'assistant' ? 'assistant' : 'user';
            $content = trim((string) ($h['content'] ?? ''));
            if ($content !== '') $messages[] = ['role' => $role, 'content' => $content];
        }
        $messages[] = ['role' => 'user', 'content' => $text];

        $result = $this->ai->json($messages, $this->schema(), $model);

        $usage = $result['_usage'] ?? [];
        $drafts = [];
        foreach (($result['operations'] ?? []) as $op) {
            $drafts[] = $this->toDraft($op, $accounts, $projects, $dicts);
        }

        // Сырой ответ модели возвращаем, чтобы фронт добавил его в историю диалога
        $raw = $result;
        unset($raw['_usage']);

        return [
            'drafts'    => $drafts,
            'new_items' => $this->newItems($result['dictionary_items'] ?? [], $dicts),
            'assistant' => json_encode($raw, JSON_UNESCAPED_UNICODE),
            'usage'     => $usage,
            'text'      => $text,
        ];
    }

    /** Человеческие названия типов справочников (для UI). */
    private const TYPE_LABELS = [
        'partner' => 'Контрагент', 'cash' => 'Касса/Счёт', 'flow' => 'Статья ДДС',
        'revenue' => 'Статья дохода', 'expenses' => 'Статья расхода',
        'product' => 'Товар/Услуга', 'employee' => 'Сотрудник', 'department' => 'Отдел',
    ];

    /**
     * Предложения создать элементы справочника.
     * Уже существующие отсеиваем — модель иногда предлагает дубли.
     */
    private function newItems(array $items, array $dicts): array
    {
        // Что создаём в этой же пачке — чтобы понять, что родитель ещё не существует
        $proposed = [];
        foreach ($items as $it) {
            $t = $it['type'] ?? null; $n = trim((string) ($it['name'] ?? ''));
            if ($t && $n !== '') $proposed[$t][$this->norm($n)] = true;
        }

        $out = [];
        foreach ($items as $it) {
            $type = $it['type'] ?? null;
            $name = trim((string) ($it['name'] ?? ''));
            if (!$type || $name === '' || !in_array($type, self::ANALYTIC_TYPES, true)) continue;
            if (isset($dicts[$type]) && $this->matchByName($dicts[$type], $name)) continue;   // уже есть

            $parentName = trim((string) ($it['parent'] ?? ''));
            $parentId = null; $parentPending = false;
            if ($parentName !== '') {
                $parentId = isset($dicts[$type]) ? $this->matchByName($dicts[$type], $parentName) : null;
                if (!$parentId && isset($proposed[$type][$this->norm($parentName)])) $parentPending = true;
            }

            $out[$type . '|' . $this->norm($name)] = [
                'type'           => $type,
                'label'          => self::TYPE_LABELS[$type] ?? $type,
                'name'           => $name,
                'parent_name'    => $parentName !== '' ? $parentName : null,
                'parent_id'      => $parentId,
                'parent_pending' => $parentPending,   // родителя тоже надо создать — он в этом же списке
            ];
        }

        // Родители раньше детей, иначе при массовом создании не к чему привязаться
        $list = array_values($out);
        usort($list, fn($a, $b) => ($a['parent_pending'] ? 1 : 0) <=> ($b['parent_pending'] ? 1 : 0));
        return $list;
    }

    /** Справочники тенанта по типам: [type => [id => name]] */
    private function dictionaries(string $db): array
    {
        $rows = DB::connection($db)->table('info')
            ->whereIn('type', self::ANALYTIC_TYPES)
            ->whereNull('deleted_at')->where('is_active', true)
            ->get(['id', 'name', 'type']);

        $out = [];
        foreach ($rows as $r) $out[$r->type][$r->id] = $r->name;
        return $out;
    }

    private function systemPrompt($accounts, array $dicts, $projects): string
    {
        $acc = [];
        foreach ($accounts as $a) {
            $an = array_filter([$a->info_1_type, $a->info_2_type]);
            $acc[] = "{$a->code} — {$a->name}" . ($an ? ' [аналитика: ' . implode(', ', $an) . ']' : '');
        }

        $dictText = '';
        foreach ($dicts as $type => $items) {
            $names = array_slice(array_values($items), 0, 80);
            $dictText .= "\n{$type}: " . implode('; ', $names);
        }

        $prj = [];
        foreach ($projects as $p) $prj[] = $p->name;

        $today = Carbon::now()->toDateString();

        return <<<TXT
Ты — помощник бухгалтера в системе учёта FINDIR. Преобразуешь описание хозяйственной
операции на русском языке в проводку двойной записи.

СЕГОДНЯ: {$today}

ПЛАН СЧЕТОВ (используй ТОЛЬКО эти коды; пиши их РОВНО как здесь, кириллицей —
буквы А и П кириллические, не латинские A и P):
- {$this->join($acc)}

СПРАВОЧНИКИ (подбирай точное название из списка; если подходящего нет — верни null):{$dictText}

ПРОЕКТЫ: {$this->joinInline($prj)}

ПРАВИЛА:
1. Дебет (debit_code) — счёт, который получает/увеличивается. Кредит (credit_code) — источник.
   Примеры: выручка на счёт → дебет А100 (деньги), кредит П587 (доходы).
   Оплата расхода со счёта → дебет П589 (расходы), кредит А100 (деньги).
1a. ВЫБОР СЧЁТА ДЕБЕТА — сначала ищи специализированный счёт, и только потом расходы:
   • покупка запасов (продукты, товары, материалы, сырьё) → счёт запасов (А200/А230/А240),
     а НЕ счёт расходов: на складе появился актив;
   • выплата/начисление сотрудникам (зарплата, аванс, премия) → счёт расчётов с
     сотрудниками (П335), а НЕ счёт расходов;
   • погашение долга поставщику или аванс ему → счёт расчётов с поставщиками (П100/П110/П150/А410);
   • оплата от клиента в счёт долга → счёт расчётов с клиентами (А405);
   • счёт расходов (П589) — только для затрат, у которых НЕТ отдельного счёта запасов
     или расчётов: аренда, услуги, реклама, комиссии.
2. amount — положительное число.
3. date — YYYY-MM-DD. «вчера», «сегодня», «5 марта» считай от СЕГОДНЯ. Если дата не указана — СЕГОДНЯ.
4. В analytics заполняй ТОЛЬКО те типы, которые есть в аналитике выбранных счетов,
   названиями ТОЧНО из справочников выше. Если не уверен — null и опиши в question.
5. Если в тексте несколько операций — верни несколько элементов operations.
6. confidence: 1.0 — всё однозначно; ниже 0.7 — есть догадки. В question укажи, что уточнить.
7. content — краткое описание операции по-русски.

СПРАВОЧНИКИ — СОЗДАНИЕ НОВЫХ ЭЛЕМЕНТОВ (dictionary_items):
8. Если пользователь просит добавить элемент справочника («добавь поставщика Арендодатель»,
   «новая статья расхода Реклама») — верни его в dictionary_items, а operations оставь ПУСТЫМ.
9. Если для операции нужен элемент, которого нет в справочниках выше, — добавь его
   в dictionary_items (а в analytics укажи это же название).
10. Типы: partner — контрагенты, поставщики, клиенты, арендодатели; cash — кассы и счета;
   flow — статьи движения денег; revenue — статьи доходов; expenses — статьи расходов;
   product — товары, услуги, продукты; employee — сотрудники; department — отделы.
   Если элемент уже есть в списках выше — НЕ добавляй его в dictionary_items.
10a. parent — название родительской группы для иерархии (или null для верхнего уровня).
   Родителем может быть как существующий элемент справочника, так и другой элемент
   из этого же списка dictionary_items — тогда сначала перечисли родителя, потом дочерние.
10b. НАПОЛНЕНИЕ СПРАВОЧНИКА: если просят «заполни статьи ДДС», «создай типовые статьи
   расходов», «наполни справочник» — предложи связный набор с иерархией: сначала группы
   верхнего уровня (parent = null), затем их дочерние статьи с указанием parent.
   Ориентируйся на отрасль пользователя; не дублируй уже существующие элементы.
11. Если контрагент/сотрудник назван, но у выбранных счетов НЕТ подходящей аналитики
   (например, нет типа partner) — ОБЯЗАТЕЛЬНО впиши его название в content,
   например «Аренда помещения, ООО Сириус», чтобы информация не потерялась.

ДИАЛОГ:
12. Это диалог. Пользователь может уточнять и исправлять предыдущий вариант
   («статья должна быть другой», «это за июль», «сумма 5000, а не 50000»).
   В таком случае верни ПОЛНЫЙ обновлённый вариант операции со всеми полями,
   сохранив то, что пользователь не менял. Не проси подтверждения — просто исправь.
13. Если пользователь просит статью/контрагента, которого нет в справочниках, —
   добавь его в dictionary_items и используй это название в analytics.
TXT;
    }

    private function join(array $a): string { return implode("\n- ", $a); }
    private function joinInline(array $a): string { return $a ? implode('; ', $a) : '—'; }

    private function schema(): array
    {
        $analytics = [];
        foreach (self::ANALYTIC_TYPES as $t) {
            $analytics[$t] = ['type' => ['string', 'null']];
        }

        return [
            'type' => 'object',
            'additionalProperties' => false,
            'required' => ['operations', 'dictionary_items'],
            'properties' => [
                'dictionary_items' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'additionalProperties' => false,
                        'required' => ['type', 'name', 'parent'],
                        'properties' => [
                            'type'   => ['type' => 'string', 'enum' => self::ANALYTIC_TYPES],
                            'name'   => ['type' => 'string'],
                            'parent' => ['type' => ['string', 'null']],   // название родительской группы
                        ],
                    ],
                ],
                'operations' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'additionalProperties' => false,
                        'required' => ['date', 'amount', 'debit_code', 'credit_code', 'project', 'analytics', 'content', 'confidence', 'question'],
                        'properties' => [
                            'date'        => ['type' => 'string'],
                            'amount'      => ['type' => 'number'],
                            'debit_code'  => ['type' => 'string'],
                            'credit_code' => ['type' => 'string'],
                            'project'     => ['type' => ['string', 'null']],
                            'content'     => ['type' => 'string'],
                            'confidence'  => ['type' => 'number'],
                            'question'    => ['type' => ['string', 'null']],
                            'analytics'   => [
                                'type' => 'object',
                                'additionalProperties' => false,
                                'required' => self::ANALYTIC_TYPES,
                                'properties' => $analytics,
                            ],
                        ],
                    ],
                ],
            ],
        ];
    }

    /** Ответ модели → payload операции + пояснения для пользователя. */
    private function toDraft(array $op, $accounts, $projects, array $dicts): array
    {
        $warnings = [];

        $inBi  = $this->findAccount($accounts, $op['debit_code'] ?? null);
        $outBi = $this->findAccount($accounts, $op['credit_code'] ?? null);
        if (!$inBi)  $warnings[] = 'Не найден счёт дебета: ' . ($op['debit_code'] ?? '—');
        if (!$outBi) $warnings[] = 'Не найден счёт кредита: ' . ($op['credit_code'] ?? '—');

        // Названия аналитик → id справочников тенанта
        $resolved = [];
        foreach (($op['analytics'] ?? []) as $type => $name) {
            if (!$name || !isset($dicts[$type])) continue;
            $id = $this->matchByName($dicts[$type], $name);
            if ($id) $resolved[$type] = $id;
            else $warnings[] = "В справочнике «{$type}» не найдено: «{$name}»";
        }

        $project = $this->matchProject($projects, $op['project'] ?? null);

        $payload = [
            'date'       => $this->normalizeDate($op['date'] ?? null),
            'amount'     => abs((float) ($op['amount'] ?? 0)),
            'project_id' => $project,
            'in_bi_id'   => $inBi->id  ?? null,
            'out_bi_id'  => $outBi->id ?? null,
            'content'    => $op['content'] ?? '',
            'source'     => 'ai',
        ];
        $payload += $this->fillSlots($inBi, $resolved, 'in_');
        $payload += $this->fillSlots($outBi, $resolved, 'out_');

        return [
            'payload'    => $payload,
            'confidence' => (float) ($op['confidence'] ?? 0),
            'question'   => $op['question'] ?? null,
            'warnings'   => $warnings,
        ];
    }

    /** Раскладывает найденные аналитики по слотам info_1/info_2 конкретного счёта. */
    private function fillSlots($bi, array $resolved, string $prefix): array
    {
        $out = [$prefix . 'info_1_id' => null, $prefix . 'info_2_id' => null];
        if (!$bi) return $out;
        foreach (['info_1_type' => 1, 'info_2_type' => 2] as $field => $slot) {
            $type = $bi->{$field} ?? null;
            if ($type && isset($resolved[$type])) $out[$prefix . 'info_' . $slot . '_id'] = $resolved[$type];
        }
        return $out;
    }

    /**
     * Латиница, визуально неотличимая от кириллицы: модели регулярно пишут
     * «A100»/«P587» вместо «А100»/«П587». Приводим к кириллице перед сравнением.
     */
    private const CODE_HOMOGLYPHS = [
        'A' => 'А', 'B' => 'В', 'C' => 'С', 'E' => 'Е', 'H' => 'Н', 'K' => 'К',
        'M' => 'М', 'O' => 'О', 'P' => 'П', 'T' => 'Т', 'X' => 'Х', 'Y' => 'У',
    ];

    private function normCode(string $code): string
    {
        $out = '';
        foreach (preg_split('//u', mb_strtoupper(trim($code)), -1, PREG_SPLIT_NO_EMPTY) as $ch) {
            $out .= self::CODE_HOMOGLYPHS[$ch] ?? $ch;
        }
        return $out;
    }

    private function findAccount($accounts, ?string $code)
    {
        if (!$code) return null;
        $want = $this->normCode($code);
        foreach ($accounts as $a) if ($this->normCode($a->code) === $want) return $a;
        // Латинская P могла означать кириллическую Р, а не П
        $alt = str_replace('П', 'Р', $want);
        foreach ($accounts as $a) if ($this->normCode($a->code) === $alt) return $a;
        return null;
    }

    private function matchProject($projects, ?string $name): ?int
    {
        if ($projects->isEmpty()) return null;
        if ($name) {
            $n = $this->norm($name);
            foreach ($projects as $p) if ($this->norm($p->name) === $n) return $p->id;
        }
        return $projects->first()->id;   // по умолчанию — первый проект
    }

    /** Точное совпадение → вхождение → лучшее похожее (порог 80%). */
    private function matchByName(array $items, string $name): ?int
    {
        $n = $this->norm($name);
        foreach ($items as $id => $itemName) if ($this->norm($itemName) === $n) return (int) $id;
        foreach ($items as $id => $itemName) {
            $in = $this->norm($itemName);
            if ($in !== '' && (str_contains($in, $n) || str_contains($n, $in))) return (int) $id;
        }
        $best = null; $bestPct = 0;
        foreach ($items as $id => $itemName) {
            similar_text($n, $this->norm($itemName), $pct);
            if ($pct > $bestPct) { $bestPct = $pct; $best = (int) $id; }
        }
        return $bestPct >= 80 ? $best : null;
    }

    private function norm(string $s): string
    {
        return trim(preg_replace('/\s+/u', ' ', mb_strtolower($s)));
    }

    private function normalizeDate(?string $d): string
    {
        try { return $d ? Carbon::parse($d)->toDateString() : Carbon::now()->toDateString(); }
        catch (\Throwable) { return Carbon::now()->toDateString(); }
    }
}
