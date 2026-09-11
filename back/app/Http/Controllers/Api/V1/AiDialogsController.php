<?php

namespace App\Http\Controllers\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * История диалогов с ИИ-помощником.
 *
 * Диалог хранится целиком: лента для показа (`turns`) и контекст для модели
 * (`history`). Сервер в разбор не лезет — лента его дело только в двух местах:
 * заголовок для списка и счётчики черновиков.
 *
 * Диалог видит только автор. Это черновая работа: в ней бывают суммы и
 * контрагенты, которые человек ещё не готов показывать, а к записанным
 * операциям это отношения не имеет — те видны всем по обычным правам.
 */
class AiDialogsController extends TenantController
{
    /** Длина ленты в базе. Дальше — переписка, которую всё равно не читают */
    private const MAX_TURNS = 60;

    /** Потолок на объём ленты. Отчёты с сотнями строк раздувают JSON */
    private const MAX_BYTES = 400 * 1024;

    private function db()
    {
        return DB::connection($this->dbName);
    }

    /** GET /ai/dialogs — свои диалоги, свежие сверху */
    public function index(Request $request)
    {
        $this->initTenant($request);

        $userId = $this->currentUserId($request);
        if (!$userId) return response()->json(['data' => []]);

        $rows = $this->db()->table('ai_dialogs')
            ->where('user_id', $userId)
            ->orderByDesc('updated_at')
            ->limit(50)
            // turns и history не выбираем: список должен быть лёгким, а лента
            // одного диалога весит больше, чем все заголовки вместе
            ->get(['id', 'title', 'drafts_total', 'drafts_saved', 'cost', 'total_tokens', 'created_at', 'updated_at']);

        return response()->json(['data' => $rows->map(fn($r) => [
            'id'           => (int) $r->id,
            'title'        => $r->title,
            'drafts_total' => (int) $r->drafts_total,
            'drafts_saved' => (int) $r->drafts_saved,
            'cost'         => $r->cost === null ? null : (float) $r->cost,
            'total_tokens' => (int) $r->total_tokens,
            'created_at'   => $r->created_at,
            'updated_at'   => $r->updated_at,
        ])]);
    }

    /** GET /ai/dialogs/{id} — диалог целиком */
    public function show(Request $request, int $id)
    {
        $this->initTenant($request);

        $row = $this->own($request, $id);
        if (!$row) return $this->notFound();

        return response()->json(['data' => [
            'id'         => (int) $row->id,
            'title'      => $row->title,
            'turns'      => json_decode($row->turns ?? '[]', true) ?: [],
            'history'    => json_decode($row->history ?? '[]', true) ?: [],
            'updated_at' => $row->updated_at,
        ]]);
    }

    /** POST /ai/dialogs — начать хранить диалог */
    public function store(Request $request)
    {
        $this->initTenant($request);

        $userId = $this->currentUserId($request);
        if (!$userId) return $this->noUser();

        $data = $this->payload($request);

        $id = $this->db()->table('ai_dialogs')->insertGetId($data + [
            'user_id'    => $userId,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return response()->json(['data' => ['id' => $id]], 201);
    }

    /** PUT /ai/dialogs/{id} — сохранить текущее состояние */
    public function update(Request $request, int $id)
    {
        $this->initTenant($request);

        if (!$this->own($request, $id)) return $this->notFound();

        $this->db()->table('ai_dialogs')->where('id', $id)->update(
            $this->payload($request) + ['updated_at' => now()]
        );

        return response()->json(['data' => ['id' => $id]]);
    }

    /** DELETE /ai/dialogs/{id} */
    public function destroy(Request $request, int $id)
    {
        $this->initTenant($request);

        if (!$this->own($request, $id)) return $this->notFound();

        $this->db()->table('ai_dialogs')->where('id', $id)->delete();

        return response()->json(['ok' => true]);
    }

    /** Строка диалога, если она принадлежит этому человеку */
    private function own(Request $request, int $id)
    {
        $userId = $this->currentUserId($request);
        if (!$userId) return null;

        return $this->db()->table('ai_dialogs')
            ->where('id', $id)->where('user_id', $userId)
            ->first();
    }

    /**
     * Чужой диалог для человека не существует — 404, а не 403.
     * Отказ «нет доступа» сам по себе сообщает, что диалог с таким номером есть.
     */
    private function notFound()
    {
        return response()->json(['message' => 'Диалог не найден'], 404);
    }

    private function noUser()
    {
        return response()->json(['message' => 'Диалог сохраняется за пользователем — войдите заново'], 401);
    }

    /**
     * Поля для записи.
     *
     * Ленту режем по длине и по объёму: старые реплики уходят первыми, потому
     * что работают всегда с последним ответом. Обрезка молчаливая — падать
     * посреди диалога из-за длины истории было бы хуже потери десятой реплики.
     */
    private function payload(Request $request): array
    {
        $data = $request->validate([
            'turns'             => 'nullable|array',
            'history'           => 'nullable|array|max:20',
            'history.*.role'    => 'required|string|in:user,assistant',
            'history.*.content' => 'required|string|max:8000',
        ]);

        $turns = array_values($data['turns'] ?? []);
        if (count($turns) > self::MAX_TURNS) {
            $turns = array_slice($turns, -self::MAX_TURNS);
        }

        $json = json_encode($turns, JSON_UNESCAPED_UNICODE);
        while (strlen($json) > self::MAX_BYTES && count($turns) > 1) {
            array_shift($turns);
            $json = json_encode($turns, JSON_UNESCAPED_UNICODE);
        }

        return [
            'title'        => $this->title($turns),
            'turns'        => $json,
            'history'      => json_encode($data['history'] ?? [], JSON_UNESCAPED_UNICODE),
            'drafts_total' => $this->countDrafts($turns, false),
            'drafts_saved' => $this->countDrafts($turns, true),
            'cost'         => $this->sum($turns, 'cost'),
            'total_tokens' => (int) $this->sum($turns, 'total_tokens'),
        ];
    }

    /** Заголовок — первая реплика человека: по ней диалог и узнают в списке */
    private function title(array $turns): string
    {
        foreach ($turns as $t) {
            if (($t['role'] ?? '') === 'user' && trim((string) ($t['text'] ?? '')) !== '') {
                return mb_substr(trim((string) $t['text']), 0, 120);
            }
        }

        return 'Без названия';
    }

    private function countDrafts(array $turns, bool $onlySaved): int
    {
        $n = 0;
        foreach ($turns as $t) {
            foreach ((array) ($t['drafts'] ?? []) as $d) {
                if (!$onlySaved || !empty($d['saved'])) $n++;
            }
        }

        return min($n, 65535);
    }

    /** Сумма по полю charge всех ответов ленты */
    private function sum(array $turns, string $key): float
    {
        $sum = 0;
        foreach ($turns as $t) {
            $v = $t['charge'][$key] ?? null;
            if (is_numeric($v)) $sum += (float) $v;
        }

        return round($sum, 6);
    }
}
