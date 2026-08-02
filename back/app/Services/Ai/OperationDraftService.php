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

    /** Что делать с приложенным файлом, если пользователь не написал ничего своего. */
    private const FILE_INSTRUCTION = 'Распознай приложенный документ (чек, счёт, накладную, выписку) '
        . 'и сформируй по нему операции. Если документов/строк несколько — верни несколько операций. '
        . 'В reply коротко перечисли, что распознал.';

    /**
     * @param array $history Предыдущие реплики диалога: [['role'=>'user|assistant','content'=>...]]
     */
    public function parse(string $db, string $text, ?string $model = null, array $history = []): array
    {
        return $this->run($db, $text, $model, $history);
    }

    /**
     * Разбор приложенного файла: картинка → vision-модель, таблица/текст → обычная.
     */
    public function parseFile(string $db, \Illuminate\Http\UploadedFile $file, string $text = '', ?string $model = null, array $history = []): array
    {
        $mime = (string) $file->getMimeType();
        $name = $file->getClientOriginalName() ?: 'file';

        if (str_starts_with($mime, 'image/')) {
            [$mime, $binary] = $this->prepareImage($file);
            $dataUrl = 'data:' . $mime . ';base64,' . base64_encode($binary);
            $content = [
                ['type' => 'text', 'text' => ($text !== '' ? $text . "\n\n" : '') . self::FILE_INSTRUCTION],
                ['type' => 'image_url', 'image_url' => ['url' => $dataUrl]],
            ];
            return $this->run($db, $content, $model ?: config('services.routerai.model_vision'), $history);
        }

        // PDF разбирает сам RouterAI (плагин file-parser), поэтому подойдёт любая модель:
        // cloudflare-ai — бесплатное извлечение текста, mistral-ocr — для сканов.
        if ($mime === 'application/pdf' || mb_strtolower($file->getClientOriginalExtension()) === 'pdf') {
            $dataUrl = 'data:application/pdf;base64,' . base64_encode((string) file_get_contents($file->getRealPath()));
            $content = [
                ['type' => 'text', 'text' => ($text !== '' ? $text . "\n\n" : '') . self::FILE_INSTRUCTION],
                ['type' => 'file', 'file' => ['filename' => $name, 'file_data' => $dataUrl]],
            ];
            $plugins = [['id' => 'file-parser', 'pdf' => ['engine' => config('services.routerai.pdf_engine')]]];
            return $this->run($db, $content, $model, $history, ['plugins' => $plugins]);
        }

        $extracted = $this->extractText($file);
        $prompt = ($text !== '' ? $text . "\n\n" : self::FILE_INSTRUCTION . "\n\n")
            . "Содержимое файла «{$name}»:\n" . $extracted;

        return $this->run($db, $prompt, $model, $history);
    }

    /**
     * Сжимаем изображение перед отправкой: фото с телефона на 8–12 Мп стоит
     * в разы дороже по токенам, а для чтения чека хватает 1400 px по длинной стороне.
     *
     * @return array{0:string,1:string} [mime, бинарные данные]
     */
    private function prepareImage(\Illuminate\Http\UploadedFile $file): array
    {
        $data = (string) file_get_contents($file->getRealPath());
        $img = @imagecreatefromstring($data);
        if (!$img) return [(string) $file->getMimeType(), $data];   // GD не осилил — шлём как есть

        $w = imagesx($img); $h = imagesy($img); $max = 1400;
        if (max($w, $h) > $max) {
            $k = $max / max($w, $h);
            $nw = (int) round($w * $k); $nh = (int) round($h * $k);
            $dst = imagecreatetruecolor($nw, $nh);
            imagecopyresampled($dst, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
            imagedestroy($img);
            $img = $dst;
        }

        ob_start(); imagejpeg($img, null, 82); $out = (string) ob_get_clean();
        imagedestroy($img);

        return ['image/jpeg', $out];
    }

    /** Текст из табличных/текстовых файлов. Картинки сюда не попадают. */
    private function extractText(\Illuminate\Http\UploadedFile $file): string
    {
        $ext = mb_strtolower($file->getClientOriginalExtension() ?: '');
        $path = $file->getRealPath();

        if (in_array($ext, ['xlsx', 'xls', 'ods'], true)) {
            $sheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($path)->getActiveSheet();
            $lines = [];
            foreach ($sheet->toArray(null, true, false, false) as $row) {
                $row = array_map(fn($c) => trim((string) $c), $row);
                if (implode('', $row) === '') continue;
                $lines[] = implode(' | ', $row);
                if (count($lines) >= 300) { $lines[] = '… (файл обрезан)'; break; }
            }
            return implode("\n", $lines);
        }

        $raw = (string) file_get_contents($path);
        if (!mb_check_encoding($raw, 'UTF-8')) $raw = mb_convert_encoding($raw, 'UTF-8', 'Windows-1251');
        return mb_substr($raw, 0, 40000);
    }

    /**
     * Общее ядро: собирает промпт со справочниками тенанта, шлёт запрос,
     * раскладывает ответ модели по id справочников.
     *
     * @param string|array $userContent Текст либо мультимодальный контент (текст + картинка)
     */
    private function run(string $db, string|array $userContent, ?string $model, array $history, array $extra = []): array
    {
        $accounts = DB::connection($db)->table('balance_items')
            ->orderBy('code')->get(['id', 'code', 'name', 'info_1_type', 'info_2_type']);

        $projects = DB::connection($db)->table('projects')
            ->whereNull('deleted_at')->orderBy('id')->get(['id', 'name']);

        $dicts = $this->dictionaries($db);
        $flowExpense = $this->flowExpenseMap($db);   // статья ДДС → статья расхода

        $messages = [['role' => 'system', 'content' => $this->systemPrompt($accounts, $dicts, $projects, $flowExpense)]];
        foreach ($history as $h) {
            $role = ($h['role'] ?? '') === 'assistant' ? 'assistant' : 'user';
            $content = trim((string) ($h['content'] ?? ''));
            if ($content !== '') $messages[] = ['role' => $role, 'content' => $content];
        }
        $messages[] = ['role' => 'user', 'content' => $userContent];

        $result = $this->ai->json($messages, $this->schema(), $model, $extra);

        $usage = $result['_usage'] ?? [];
        $drafts = [];
        foreach (($result['operations'] ?? []) as $op) {
            $drafts[] = $this->toDraft($op, $accounts, $projects, $dicts, $flowExpense);
        }

        // Сырой ответ модели возвращаем, чтобы фронт добавил его в историю диалога
        $raw = $result;
        unset($raw['_usage']);

        return [
            'reply'     => trim((string) ($result['reply'] ?? '')),
            'drafts'    => $drafts,
            'new_items' => $this->newItems($result['dictionary_items'] ?? [], $dicts),
            'links'     => $this->links($result['links'] ?? [], $dicts, $flowExpense),
            'bulk'      => $this->bulkPreview($db, $result['bulk_updates'] ?? [], $dicts, $accounts),
            'assistant' => json_encode($raw, JSON_UNESCAPED_UNICODE),
            'usage'     => $usage,
        ];
    }

    /**
     * Массовая правка: разбираем условия, считаем попадание, показываем примеры.
     * Ничего не меняет — только предпросмотр для подтверждения пользователем.
     */
    private function bulkPreview(string $db, array $updates, array $dicts, $accounts): array
    {
        $out = [];
        foreach ($updates as $u) {
            $spec = $this->normalizeBulk($u, $dicts, $accounts);
            if (!$spec) continue;

            $q = $this->bulkQuery($db, $spec['filter']);
            $spec['count']  = (clone $q)->count();
            $spec['sample'] = (clone $q)->orderBy('date')->limit(3)
                ->get(['id', 'date', 'amount', 'content'])
                ->map(fn($o) => [
                    'id' => $o->id, 'date' => substr((string) $o->date, 0, 10),
                    'amount' => (float) $o->amount, 'content' => mb_substr((string) $o->content, 0, 60),
                ])->all();

            if ($spec['count'] > 0) $out[] = $spec;
        }
        return $out;
    }

    /** Условия и значения из ответа модели → проверенная спецификация с id. */
    private function normalizeBulk(array $u, array $dicts, $accounts): ?array
    {
        $f = $u['filter'] ?? [];
        $code = trim((string) ($f['account_code'] ?? ''));
        $acc  = $code !== '' ? $this->findAccount($accounts, $code) : null;
        if ($code !== '' && !$acc) return null;                 // счёт не опознан — не гадаем

        $side = in_array($f['side'] ?? null, ['debit', 'credit', 'any'], true) ? $f['side'] : 'any';

        $set = [];
        foreach (($u['set'] ?? []) as $type => $name) {
            if (!$name || !in_array($type, self::ANALYTIC_TYPES, true) || !isset($dicts[$type])) continue;
            $id = $this->matchByName($dicts[$type], (string) $name);
            if ($id) $set[$type] = ['id' => $id, 'name' => $dicts[$type][$id]];
        }
        if (!$set) return null;                                  // нечего проставлять

        $filter = [
            'date_from'    => $this->dateOrNull($f['date_from'] ?? null),
            'date_to'      => $this->dateOrNull($f['date_to'] ?? null),
            'account_id'   => $acc->id ?? null,
            'account_code' => $acc->code ?? null,
            'side'         => $side,
            'content_like' => trim((string) ($f['content_like'] ?? '')) ?: null,
        ];
        // Фильтр без единого условия затронул бы всю базу — отклоняем
        if (!array_filter([$filter['date_from'], $filter['date_to'], $filter['account_id'], $filter['content_like']])) {
            return null;
        }

        return ['filter' => $filter, 'set' => $set, 'reason' => (string) ($u['reason'] ?? '')];
    }

    /** Запрос по операциям согласно фильтру. */
    private function bulkQuery(string $db, array $f)
    {
        $q = DB::connection($db)->table('operations')->whereNull('deleted_at');

        if ($f['date_from']) $q->where('date', '>=', $f['date_from'] . ' 00:00:00');
        if ($f['date_to'])   $q->where('date', '<=', $f['date_to'] . ' 23:59:59');
        if ($f['content_like']) $q->where('content', 'like', '%' . $f['content_like'] . '%');

        if ($f['account_id']) {
            $id = $f['account_id'];
            if ($f['side'] === 'debit')       $q->where('in_bi_id', $id);
            elseif ($f['side'] === 'credit')  $q->where('out_bi_id', $id);
            else $q->where(fn($w) => $w->where('in_bi_id', $id)->orWhere('out_bi_id', $id));
        }

        return $q;
    }

    /**
     * Применить массовую правку. Возвращает [обновлено, пропущено].
     * Аналитика пишется в тот слот счёта, который объявлен под этот тип —
     * поэтому «выручка» ляжет именно в revenue-слот, а не куда попало.
     */
    public function applyBulk(string $db, array $filter, array $set): array
    {
        $accounts = DB::connection($db)->table('balance_items')
            ->get(['id', 'code', 'info_1_type', 'info_2_type', 'info_3_type'])->keyBy('id');

        // Тянем и текущие значения слотов — они понадобятся для отката
        $ops = $this->bulkQuery($db, $filter)->get([
            'id', 'in_bi_id', 'out_bi_id',
            'in_info_1_id', 'in_info_2_id', 'in_info_3_id',
            'out_info_1_id', 'out_info_2_id', 'out_info_3_id',
        ]);

        $updated = 0; $skipped = 0; $undo = [];
        foreach ($ops as $op) {
            $patch = [];
            foreach ($set as $type => $v) {
                $id = is_array($v) ? ($v['id'] ?? null) : $v;
                if (!$id) continue;

                foreach ([['in', $op->in_bi_id], ['out', $op->out_bi_id]] as [$prefix, $biId]) {
                    // Если сторона в фильтре задана — пишем только в неё
                    if ($filter['side'] === 'debit'  && $prefix !== 'in')  continue;
                    if ($filter['side'] === 'credit' && $prefix !== 'out') continue;

                    $bi = $accounts[$biId] ?? null;
                    if (!$bi) continue;
                    foreach ([1, 2, 3] as $n) {
                        if (($bi->{"info_{$n}_type"} ?? null) === $type) {
                            $patch["{$prefix}_info_{$n}_id"] = $id;
                            break;
                        }
                    }
                }
            }

            if (!$patch) { $skipped++; continue; }

            // Прежние значения именно тех полей, которые меняем
            $before = [];
            foreach (array_keys($patch) as $field) $before[$field] = $op->{$field} ?? null;
            if ($before == array_map(fn($v) => $v, $patch)) { $skipped++; continue; }   // и так уже так

            $undo[] = ['id' => $op->id, 'before' => $before];

            $patch['updated_at'] = now();
            DB::connection($db)->table('operations')->where('id', $op->id)->update($patch);
            $updated++;
        }

        $logId = null;
        if ($updated > 0) {
            $logId = DB::connection($db)->table('bulk_update_log')->insertGetId([
                'filter'      => json_encode($filter, JSON_UNESCAPED_UNICODE),
                'changes_set' => json_encode($set, JSON_UNESCAPED_UNICODE),
                'undo'        => json_encode($undo, JSON_UNESCAPED_UNICODE),
                'affected'    => $updated,
                'description' => $this->bulkDescription($filter, $set),
                'created_at'  => now(),
                'updated_at'  => now(),
            ]);
        }

        return ['updated' => $updated, 'skipped' => $skipped, 'log_id' => $logId];
    }

    /** Откат массовой правки по журналу. */
    public function revertBulk(string $db, int $logId, ?string $lockDate = null): array
    {
        $log = DB::connection($db)->table('bulk_update_log')->where('id', $logId)->first();
        if (!$log)               return ['ok' => false, 'message' => 'Запись журнала не найдена'];
        if ($log->reverted_at)   return ['ok' => false, 'message' => 'Эта правка уже откачена'];

        $undo = json_decode($log->undo, true) ?: [];
        $restored = 0; $skipped = 0;

        foreach ($undo as $u) {
            $id = $u['id'] ?? null;
            $before = $u['before'] ?? [];
            if (!$id || !$before) continue;

            $op = DB::connection($db)->table('operations')->where('id', $id)->whereNull('deleted_at')
                ->first(['id', 'date']);
            if (!$op) { $skipped++; continue; }                       // операция удалена
            if ($lockDate && substr((string) $op->date, 0, 10) <= $lockDate) { $skipped++; continue; }

            DB::connection($db)->table('operations')->where('id', $id)
                ->update($before + ['updated_at' => now()]);
            $restored++;
        }

        DB::connection($db)->table('bulk_update_log')->where('id', $logId)
            ->update(['reverted_at' => now(), 'updated_at' => now()]);

        return ['ok' => true, 'restored' => $restored, 'skipped' => $skipped];
    }

    private function bulkDescription(array $f, array $set): string
    {
        $parts = [];
        if ($f['date_from'] ?? null) $parts[] = "с {$f['date_from']}";
        if ($f['date_to'] ?? null)   $parts[] = "по {$f['date_to']}";
        if ($f['account_code'] ?? null) $parts[] = "счёт {$f['account_code']}";
        if ($f['content_like'] ?? null) $parts[] = "текст «{$f['content_like']}»";
        $what = [];
        foreach ($set as $t => $v) $what[] = $t . ' → ' . (is_array($v) ? ($v['name'] ?? '') : $v);
        return mb_substr(implode(', ', $parts) . ': ' . implode('; ', $what), 0, 500);
    }

    private function dateOrNull(?string $d): ?string
    {
        if (!$d) return null;
        try { return Carbon::parse($d)->toDateString(); } catch (\Throwable) { return null; }
    }

    /**
     * Предложенные связи «статья ДДС → статья расхода».
     * Названия резолвим в id справочника тенанта; уже проставленные пропускаем.
     */
    private function links(array $links, array $dicts, array $flowExpense): array
    {
        $out = [];
        foreach ($links as $l) {
            $flowName = trim((string) ($l['flow'] ?? ''));
            $expName  = trim((string) ($l['expense'] ?? ''));
            if ($flowName === '' || $expName === '') continue;

            $flowId = isset($dicts['flow']) ? $this->matchByName($dicts['flow'], $flowName) : null;
            $expId  = isset($dicts['expenses']) ? $this->matchByName($dicts['expenses'], $expName) : null;
            if (!$flowId || !$expId) continue;                  // нет в справочниках — пропускаем
            if (($flowExpense[$flowId] ?? null) === $expId) continue;   // уже связано так же

            $out[$flowId] = [
                'flow_id'      => $flowId,
                'flow_name'    => $dicts['flow'][$flowId],
                'expense_id'   => $expId,
                'expense_name' => $dicts['expenses'][$expId],
                'replaces'     => isset($flowExpense[$flowId])
                    ? ($dicts['expenses'][$flowExpense[$flowId]] ?? null) : null,
            ];
        }
        return array_values($out);
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

    /**
     * Связь «статья ДДС → статья расхода» (info.default_expense_id).
     * Нужна, когда кассовый метод и метод начисления совпадают: выбрали статью
     * движения денег — статья расхода подставляется сама.
     *
     * @return array [flow_id => expense_id]
     */
    private function flowExpenseMap(string $db): array
    {
        return DB::connection($db)->table('info')
            ->where('type', 'flow')->whereNotNull('default_expense_id')
            ->whereNull('deleted_at')->where('is_active', true)
            ->pluck('default_expense_id', 'id')
            ->map(fn($v) => (int) $v)
            ->all();
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

    private function systemPrompt($accounts, array $dicts, $projects, array $flowExpense = []): string
    {
        // Пары «статья ДДС → статья расхода», чтобы модель выбирала их согласованно
        $links = '';
        foreach ($flowExpense as $flowId => $expId) {
            $f = $dicts['flow'][$flowId] ?? null;
            $e = $dicts['expenses'][$expId] ?? null;
            if ($f && $e) $links .= "\n- {$f} → {$e}";
        }
        $links = $links === '' ? '' : <<<L

СВЯЗИ «СТАТЬЯ ДДС → СТАТЬЯ РАСХОДА» (кассовый метод совпадает с начислением —
выбрав статью ДДС, указывай в expenses именно связанную статью):{$links}
L;

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
{$links}

ЧЕСТНОСТЬ О СВОИХ ВОЗМОЖНОСТЯХ (важнее всего):
- Ты НЕ видишь уже созданные операции и НЕ можешь менять их напрямую.
- НИКОГДА не пиши «я проставил», «я изменил», «готово» — ты ничего не меняешь сам.
  Всё, что ты возвращаешь, — это ПРЕДЛОЖЕНИЯ, которые применит пользователь кнопкой.
- Если просят массово поправить существующие операции («проставь статью дохода всем
  операциям за июнь») — не отказывайся и не проси перечислить их вручную:
  верни описание массовой правки в bulk_updates, система сама найдёт операции.

ГЛАВНОЕ — ВСЕГДА ОТВЕЧАЙ:
0. Поле reply заполняй ВСЕГДА: краткий ответ по-русски на то, что просил пользователь.
   Это может быть список из справочников выше, пояснение, что ты предлагаешь или сделал.
   На вопросы («покажи статьи ДДС», «какие есть статьи расходов», «посмотри и предложи»)
   отвечай именно в reply, опираясь на справочники выше. Не оставляй reply пустым никогда.
   Если операции создавать не нужно — operations оставь пустым, но reply заполни.

СВЯЗИ СТАТЕЙ ДДС И РАСХОДОВ:
0a. Если просят связать/привязать статьи ДДС со статьями расходов — верни пары в links:
   flow — точное название статьи ДДС, expense — точное название статьи расхода
   (оба ТОЧНО из справочников выше). В reply перечисли предлагаемые пары словами.
   Связывай только осмысленные пары; если нужной статьи расхода нет — создай её в dictionary_items.

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

МАССОВАЯ ПРАВКА СУЩЕСТВУЮЩИХ ОПЕРАЦИЙ (bulk_updates):
14a. Используй, когда просят изменить уже введённые операции по признаку
   («всем доходам за июнь проставить статью выручки», «замени статью ДДС у платежей аренды»).
   filter — как отобрать операции:
     date_from / date_to — период (YYYY-MM-DD);
     account_code — код счёта из плана счетов (например П587);
     side — на какой стороне этот счёт: debit (дебет), credit (кредит) или any;
     content_like — подстрока в содержании, если признак в тексте.
   set — что проставить: тип аналитики → ТОЧНОЕ название из справочников
     (revenue, expenses, flow, partner, product, employee, department, cash).
   Заполняй только те условия, которые реально названы; остальные — null.
14b. В reply опиши, ЧТО БУДЕТ изменено, а не «изменено». Решение применяет пользователь.

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
            'required' => ['reply', 'operations', 'dictionary_items', 'links', 'bulk_updates'],
            'properties' => [
                // Свободный ответ пользователю: списки, пояснения, что предлагается
                'reply' => ['type' => 'string'],
                // Массовая правка уже существующих операций (применяет пользователь)
                'bulk_updates' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'additionalProperties' => false,
                        'required' => ['filter', 'set', 'reason'],
                        'properties' => [
                            'reason' => ['type' => 'string'],
                            'filter' => [
                                'type' => 'object',
                                'additionalProperties' => false,
                                'required' => ['date_from', 'date_to', 'account_code', 'side', 'content_like'],
                                'properties' => [
                                    'date_from'    => ['type' => ['string', 'null']],
                                    'date_to'      => ['type' => ['string', 'null']],
                                    'account_code' => ['type' => ['string', 'null']],
                                    'side'         => ['type' => ['string', 'null'], 'enum' => ['debit', 'credit', 'any', null]],
                                    'content_like' => ['type' => ['string', 'null']],
                                ],
                            ],
                            'set' => [
                                'type' => 'object',
                                'additionalProperties' => false,
                                'required' => self::ANALYTIC_TYPES,
                                'properties' => array_fill_keys(self::ANALYTIC_TYPES, ['type' => ['string', 'null']]),
                            ],
                        ],
                    ],
                ],
                // Связи «статья ДДС → статья расхода» для простановки default_expense_id
                'links' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'additionalProperties' => false,
                        'required' => ['flow', 'expense'],
                        'properties' => [
                            'flow'    => ['type' => 'string'],
                            'expense' => ['type' => 'string'],
                        ],
                    ],
                ],
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
    private function toDraft(array $op, $accounts, $projects, array $dicts, array $flowExpense = []): array
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

        // Статья ДДС связана со статьёй расхода → подставляем её, если модель не выбрала свою
        if (!empty($resolved['flow']) && empty($resolved['expenses']) && isset($flowExpense[$resolved['flow']])) {
            $resolved['expenses'] = $flowExpense[$resolved['flow']];
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
