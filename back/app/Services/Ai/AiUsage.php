<?php

namespace App\Services\Ai;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Учёт расхода на ИИ.
 *
 * Шлюз возвращает потраченные токены в каждом ответе — здесь они превращаются
 * в строку журнала, из которого потом складывается сумма за месяц.
 *
 * Запись расхода не должна ронять сам запрос: если журнал недоступен, человек
 * всё равно получит свой черновик операции, а мы узнаем о поломке из лога.
 */
class AiUsage
{
    /** Названия видов работ — для отчёта */
    public const FEATURES = [
        'operation'  => 'Ввод операции',
        'file'       => 'Разбор файла',
        'statement'  => 'Разбор выписки',
        'transcribe' => 'Распознавание речи',
    ];

    /**
     * Записать расход одного вызова.
     *
     * `$usage` — то, что вернул шлюз. Формат у разных моделей разный, поэтому
     * читаем и общепринятые ключи OpenAI, и вложенные варианты, а сырой ответ
     * кладём рядом целиком.
     */
    public static function record(string $db, string $feature, ?string $model, array $usage, ?int $userId = null): void
    {
        try {
            $cost = self::extractCost($usage);

            DB::connection($db)->table('ai_usage')->insert([
                'feature'       => $feature,
                'model'         => $model,
                'input_tokens'  => (int) ($usage['prompt_tokens'] ?? $usage['input_tokens'] ?? 0),
                'output_tokens' => (int) ($usage['completion_tokens'] ?? $usage['output_tokens'] ?? 0),
                'total_tokens'  => (int) ($usage['total_tokens'] ?? 0),
                'cost'          => $cost['value'],
                'currency'      => $cost['currency'],
                'raw'           => $usage ? json_encode($usage, JSON_UNESCAPED_UNICODE) : null,
                'user_id'       => $userId,
                'created_at'    => now(),
                'updated_at'    => now(),
            ]);
        } catch (\Throwable $e) {
            // Учёт расхода — дело второе: без него работа продолжается
            Log::warning('AI usage not recorded: ' . $e->getMessage());
        }
    }

    /**
     * Что показать человеку за этот вызов.
     *
     * Наценку применяем здесь, а не на фронте: в чате и в отчёте о расходе
     * должна стоять одна и та же цифра, а правило её получения — одно и на
     * сервере. В журнале при этом лежит себестоимость.
     */
    public static function charge(array $usage): array
    {
        $cost   = self::extractCost($usage);
        $markup = (float) config('services.routerai.markup', 0);

        return [
            'cost'         => $cost['value'] === null ? null : round($cost['value'] * (1 + $markup / 100), 6),
            'currency'     => $cost['currency'] ?: config('services.routerai.currency'),
            'total_tokens' => (int) ($usage['total_tokens'] ?? 0),
        ];
    }

    /**
     * Стоимость из ответа шлюза.
     *
     * Единого стандарта нет: где-то `cost` в корне, где-то во вложенных
     * деталях, где-то валюта отдельным полем. Берём первое найденное и честно
     * оставляем null, если стоимости нет вовсе — тогда в отчёте будут только
     * токены, а не выдуманные рубли.
     */
    private static function extractCost(array $usage): array
    {
        $candidates = [
            $usage['cost'] ?? null,
            $usage['total_cost'] ?? null,
            $usage['cost_rub'] ?? null,
            $usage['cost_details']['total_cost'] ?? null,
            $usage['prompt_tokens_details']['cost'] ?? null,
        ];

        foreach ($candidates as $value) {
            if (is_numeric($value)) {
                return [
                    'value'    => (float) $value,
                    'currency' => $usage['currency'] ?? ($usage['cost_currency'] ?? null),
                ];
            }
        }

        return ['value' => null, 'currency' => null];
    }
}
