<?php

namespace App\Services\Ai;

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Клиент к RouterAI (routerai.ru) — OpenAI-совместимый шлюз.
 *
 * Ключ и модели берутся из config/services.php (env). Конфиг НЕ кэшируется
 * на проде, поэтому смена модели в .env применяется после restart php.
 */
class RouterAiClient
{
    private string $key;
    private string $baseUrl;
    private int $timeout;

    public function __construct()
    {
        $this->key     = (string) config('services.routerai.key');
        $this->baseUrl = rtrim((string) config('services.routerai.base_url'), '/');
        $this->timeout = (int) config('services.routerai.timeout', 60);
    }

    public function configured(): bool
    {
        return $this->key !== '';
    }

    private function assertConfigured(): void
    {
        if (!$this->configured()) {
            throw new RuntimeException('Не задан ROUTERAI_API_KEY — ИИ-функции недоступны.');
        }
    }

    /**
     * Chat Completions. $schema — JSON Schema для строгого структурированного ответа.
     * Возвращает декодированный JSON-объект ответа модели.
     */
    public function json(array $messages, array $schema, ?string $model = null): array
    {
        $this->assertConfigured();

        $payload = [
            'model'       => $model ?: config('services.routerai.model'),
            'messages'    => $messages,
            'temperature' => 0,
            'response_format' => [
                'type' => 'json_schema',
                'json_schema' => [
                    'name'   => 'operation_draft',
                    'strict' => true,
                    'schema' => $schema,
                ],
            ],
        ];

        $res = Http::withToken($this->key)
            ->timeout($this->timeout)
            ->acceptJson()
            ->post($this->baseUrl . '/chat/completions', $payload);

        if ($res->failed()) {
            throw new RuntimeException('RouterAI: ' . $res->status() . ' ' . $res->body());
        }

        // RouterAI отдаёт structured output как tool call: arguments может быть
        // объектом или строкой. Часть моделей отвечает обычным content-JSON.
        $msg  = $res->json('choices.0.message') ?: [];
        $args = $msg['tool_calls'][0]['function']['arguments'] ?? null;

        $decoded = null;
        if ($args !== null) {
            $decoded = is_array($args) ? $args : json_decode((string) $args, true);
        } elseif (is_string($msg['content'] ?? null) && $msg['content'] !== '') {
            $decoded = json_decode($msg['content'], true);
        }

        if (!is_array($decoded)) {
            throw new RuntimeException('RouterAI вернул неожиданный ответ: ' . mb_substr($res->body(), 0, 400));
        }

        // Полезно для контроля расхода токенов
        $decoded['_usage'] = $res->json('usage') ?: [];

        return $decoded;
    }

    /** Распознавание речи (OpenAI-совместимый /audio/transcriptions). */
    public function transcribe(UploadedFile $file, ?string $model = null): string
    {
        $this->assertConfigured();

        $res = Http::withToken($this->key)
            ->timeout($this->timeout)
            ->attach('file', file_get_contents($file->getRealPath()), $file->getClientOriginalName() ?: 'audio.webm')
            ->post($this->baseUrl . '/audio/transcriptions', [
                'model'    => $model ?: config('services.routerai.model_stt'),
                'language' => 'ru',
            ]);

        if ($res->failed()) {
            throw new RuntimeException('RouterAI STT: ' . $res->status() . ' ' . $res->body());
        }

        return trim((string) ($res->json('text') ?? ''));
    }
}
