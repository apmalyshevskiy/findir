<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Ai\AiUsage;
use App\Services\Ai\OperationDraftService;
use App\Services\Ai\RouterAiClient;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * ИИ-ввод операций: текст или голос → ЧЕРНОВИК проводки.
 * Ничего не сохраняет в учёт — операцию создаёт пользователь,
 * подтвердив черновик в обычной форме.
 */
class AiController extends TenantController
{
    public function __construct(
        private RouterAiClient $ai,
        private OperationDraftService $drafts,
    ) {}

    /**
     * Помощник работает в границах должности.
     *
     * Закрытые счета не должны попадать даже в промпт: спрятать их только в
     * ответе мало — модель проговорилась бы о них в свободном тексте.
     */
    protected function initTenant(Request $request): void
    {
        parent::initTenant($request);

        $this->drafts->withScope($this->scope);
    }

    /** GET /ai/status — доступны ли ИИ-функции (для показа кнопок на фронте) */
    public function status(Request $request)
    {
        return response()->json([
            'enabled' => $this->ai->configured(),
            'model'   => config('services.routerai.model'),
        ]);
    }

    /** POST /ai/parse-operation { text } */
    public function parseOperation(Request $request)
    {
        $this->initTenant($request);
        $data = $request->validate([
            'text'              => 'required|string|max:2000',
            'model'             => 'nullable|string|max:100',
            'history'           => 'nullable|array|max:20',
            'history.*.role'    => 'required|string|in:user,assistant',
            'history.*.content' => 'required|string|max:8000',
        ]);

        try {
            $res = $this->drafts->parse($this->dbName, $data['text'], $data['model'] ?? null, $data['history'] ?? []);
        } catch (\Throwable $e) {
            Log::warning('AI parse failed: ' . $e->getMessage());
            return response()->json(['message' => $e->getMessage()], 422);
        }

        // Цена запроса — чтобы в чате было видно, во что обошёлся ответ
        $res['charge'] = AiUsage::charge($res['usage'] ?? []);

        return response()->json($res);
    }

    /**
     * POST /ai/parse-file (multipart: file, text?, history?)
     * Картинка → vision-модель, таблица/текст → обычная. Возвращает черновики.
     */
    public function parseFile(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'file'              => 'required|file|max:10240',   // до 10 МБ
            'text'              => 'nullable|string|max:2000',
            'model'             => 'nullable|string|max:100',
            'history'           => 'nullable|array|max:20',
            'history.*.role'    => 'required|string|in:user,assistant',
            'history.*.content' => 'required|string|max:8000',
        ]);

        try {
            $res = $this->drafts->parseFile(
                $this->dbName,
                $request->file('file'),
                $data['text'] ?? '',
                $data['model'] ?? null,
                $data['history'] ?? []
            );
        } catch (\Throwable $e) {
            Log::warning('AI parse-file failed: ' . $e->getMessage());
            return response()->json(['message' => $e->getMessage()], 422);
        }

        $res['charge'] = AiUsage::charge($res['usage'] ?? []);

        return response()->json($res);
    }

    /**
     * POST /ai/apply-bulk — применить массовую правку существующих операций.
     * Спецификацию готовит ИИ, применяет пользователь кнопкой.
     */
    public function applyBulk(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'filter'              => 'required|array',
            'filter.date_from'    => 'nullable|date',
            'filter.date_to'      => 'nullable|date',
            'filter.account_id'   => 'nullable|integer',
            'filter.side'         => 'nullable|string|in:debit,credit,any',
            'filter.content_like' => 'nullable|string|max:255',
            'set'                 => 'required|array|min:1',
        ]);

        $f = $data['filter'] + ['date_from' => null, 'date_to' => null, 'account_id' => null,
                                'side' => 'any', 'content_like' => null];

        // Пустой фильтр затронул бы всю базу
        if (!array_filter([$f['date_from'], $f['date_to'], $f['account_id'], $f['content_like']])) {
            return response()->json(['message' => 'Слишком широкое условие — правка отклонена'], 422);
        }

        // Дата запрета редактирования: правим только то, что после неё
        $lock = $this->editLockDate();
        if ($lock) {
            $from = $f['date_from'];
            if (!$from || $from <= $lock) {
                $f['date_from'] = \Illuminate\Support\Carbon::parse($lock)->addDay()->toDateString();
            }
        }

        $res = $this->drafts->applyBulk($this->dbName, $f, $data['set']);

        return response()->json($res + ['ok' => true, 'lock_applied' => $lock ?: null]);
    }

    /** GET /ai/bulk-log — последние массовые правки (для отката) */
    public function bulkLog(Request $request)
    {
        $this->initTenant($request);

        $rows = \Illuminate\Support\Facades\DB::connection($this->dbName)
            ->table('bulk_update_log')->orderByDesc('id')->limit(20)->get();

        return response()->json(['data' => $rows->map(fn($r) => [
            'id'          => $r->id,
            'description' => $r->description,
            'affected'    => (int) $r->affected,
            'reverted_at' => $r->reverted_at,
            'created_at'  => $r->created_at,
        ])->values()]);
    }

    /** POST /ai/bulk-log/{id}/revert — вернуть прежние значения */
    public function revertBulk(Request $request, int $id)
    {
        $this->initTenant($request);

        $res = $this->drafts->revertBulk($this->dbName, $id, $this->editLockDate());

        return response()->json($res, ($res['ok'] ?? false) ? 200 : 422);
    }

    /**
     * POST /ai/classify-statement — доразбор строк выписки, которые не покрылись правилами.
     * Возвращает те же поля suggested_*, что и матчер, плюс предложения правил.
     */
    public function classifyStatement(Request $request, \App\Services\Ai\StatementClassifier $classifier)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'rows'                     => 'required|array|min:1|max:60',
            'rows.*.direction'         => 'nullable|string|in:in,out',
            'rows.*.amount'            => 'nullable|numeric',
            'rows.*.counterparty_raw'  => 'nullable|string|max:255',
            'rows.*.counterparty_inn'  => 'nullable|string|max:20',
            'rows.*.purpose_raw'       => 'nullable|string|max:1000',
            'model'                    => 'nullable|string|max:100',
        ]);

        try {
            $res = $classifier->classify($this->dbName, $data['rows'], $data['model'] ?? null);
        } catch (\Throwable $e) {
            Log::warning('AI classify-statement failed: ' . $e->getMessage());
            return response()->json(['message' => $e->getMessage()], 422);
        }

        return response()->json($res);
    }

    /**
     * POST /ai/apply-rules — создать правила классификации, подтверждённые пользователем.
     * Помечаются source=auto, чтобы отличать от заведённых руками.
     */
    public function applyRules(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'rules'                     => 'required|array|min:1',
            'rules.*.direction'         => 'required|string|in:in,out,any',
            'rules.*.inn'               => 'nullable|string|max:20',
            'rules.*.purpose_keywords'  => 'nullable|string|max:1000',
            'rules.*.category'          => 'required|string|max:32',
        ]);

        $db = \Illuminate\Support\Facades\DB::connection($this->dbName);
        $created = 0;

        foreach ($data['rules'] as $r) {
            if (empty($r['inn']) && empty($r['purpose_keywords'])) continue;   // правило без условий

            $exists = $db->table('payment_classification_rules')
                ->where('direction', $r['direction'])
                ->where('category', $r['category'])
                ->where('inn', $r['inn'] ?? null)
                ->where('purpose_keywords', $r['purpose_keywords'] ?? null)
                ->exists();
            if ($exists) continue;

            $db->table('payment_classification_rules')->insert([
                'direction'        => $r['direction'],
                'inn'              => $r['inn'] ?? null,
                'purpose_keywords' => $r['purpose_keywords'] ?? null,
                'category'         => $r['category'],
                'priority'         => 40,          // ниже правил, заведённых руками
                'source'           => 'auto',
                'is_active'        => true,
                'created_by'       => $this->currentUserId($request),
                'created_at'       => now(),
                'updated_at'       => now(),
            ]);
            $created++;
        }

        return response()->json(['ok' => true, 'created' => $created]);
    }

    /**
     * POST /ai/apply-links — проставить связь «статья ДДС → статья расхода»
     * (info.default_expense_id). Применяется только по подтверждению пользователя.
     */
    public function applyLinks(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'links'              => 'required|array|min:1',
            'links.*.flow_id'    => 'required|integer',
            'links.*.expense_id' => 'required|integer',
        ]);

        $n = 0;
        foreach ($data['links'] as $l) {
            $n += \Illuminate\Support\Facades\DB::connection($this->dbName)->table('info')
                ->where('id', $l['flow_id'])->where('type', 'flow')
                ->update(['default_expense_id' => $l['expense_id'], 'updated_at' => now()]);
        }

        return response()->json(['ok' => true, 'updated' => $n]);
    }

    /** POST /ai/transcribe (multipart: audio) → { text } */
    public function transcribe(Request $request)
    {
        $this->initTenant($request);
        $request->validate(['audio' => 'required|file|max:25600']);   // до 25 МБ

        try {
            $text = $this->ai->transcribe($request->file('audio'));
        } catch (\Throwable $e) {
            Log::warning('AI transcribe failed: ' . $e->getMessage());
            return response()->json(['message' => $e->getMessage()], 422);
        }

        // Расшифровка речи считается не токенами, а секундами звука, и usage
        // шлюз по ней обычно не возвращает. Строку всё равно пишем: без неё
        // расход на голос выпал бы из отчёта совсем
        AiUsage::record($this->dbName, 'transcribe', config('services.routerai.model_stt'), [
            'audio_bytes' => $request->file('audio')->getSize(),
        ]);

        return response()->json(['text' => $text]);
    }

    /**
     * GET /ai/usage — расход на ИИ за период.
     *
     * Показываем себестоимость с наценкой из настройки: сейчас она нулевая,
     * то есть ровно то, что стоил шлюз.
     */
    public function usage(Request $request)
    {
        $this->initTenant($request);

        $from = $request->date_from ?: now()->startOfMonth()->format('Y-m-d');
        $to   = $request->date_to   ?: now()->endOfMonth()->format('Y-m-d');

        $rows = DB::connection($this->dbName)->table('ai_usage')
            ->whereBetween('created_at', [$from . ' 00:00:00', $to . ' 23:59:59']);

        $byFeature = (clone $rows)
            ->selectRaw('feature, model, count(*) calls,
                         sum(input_tokens) input_tokens, sum(output_tokens) output_tokens,
                         sum(total_tokens) total_tokens, sum(cost) cost,
                         sum(cost is null) without_cost')
            ->groupBy('feature', 'model')
            ->orderByDesc('calls')
            ->get();

        $markup = (float) config('services.routerai.markup', 0);

        return response()->json([
            'from'   => $from,
            'to'     => $to,
            'markup' => $markup,
            'labels' => AiUsage::FEATURES,
            'totals' => [
                'calls'        => (int) (clone $rows)->count(),
                'total_tokens' => (int) (clone $rows)->sum('total_tokens'),
                'cost'         => (float) (clone $rows)->sum('cost'),
                'without_cost' => (int) (clone $rows)->whereNull('cost')->count(),
                // Шлюз валюту не присылает — берём из настройки
                'currency'     => (clone $rows)->whereNotNull('currency')->value('currency')
                    ?: config('services.routerai.currency'),
            ],
            'data'   => $byFeature,
            // Последние вызовы — по ним видно, что именно шлюз вернул
            'recent' => (clone $rows)->orderByDesc('id')->limit(20)
                ->get(['id', 'created_at', 'feature', 'model', 'input_tokens', 'output_tokens', 'cost', 'currency']),
        ]);
    }
}
