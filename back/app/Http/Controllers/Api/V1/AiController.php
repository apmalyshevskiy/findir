<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Ai\OperationDraftService;
use App\Services\Ai\RouterAiClient;
use Illuminate\Http\Request;
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

        return response()->json($res);
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

        return response()->json(['text' => $text]);
    }
}
