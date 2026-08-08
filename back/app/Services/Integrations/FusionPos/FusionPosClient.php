<?php

namespace App\Services\Integrations\FusionPos;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * HTTP-клиент FUSIONPOS API v4.
 *
 * Авторизация — постоянный токен в заголовке, логина нет. Деньги во всех
 * ответах приходят в копейках целыми числами, перевод в рубли — забота
 * вызывающего кода (см. FusionPosDriver).
 */
final class FusionPosClient
{
    /** Зона, в которой живут кабинеты: её дописываем к номеру сами. */
    public const ZONE = 'fusionpos.ru';

    private const TIMEOUT  = 30;
    private const PER_PAGE = 100;

    /** Защита от бесконечного обхода, если сервер врёт про pageCount. */
    private const MAX_PAGES = 500;

    private string $baseUrl;

    public function __construct(string $domain, private string $token)
    {
        $this->baseUrl = self::normalizeBase($domain);
    }

    /**
     * Номер кабинета в том виде, в каком его хранят и показывают в форме.
     *
     * Из «https://2791795.fusionpos.ru/» получается «2791795»: человек знает
     * свой кабинет по номеру, его и держим в поле. Свой домен (если у кабинета
     * он есть) остаётся как есть.
     */
    public static function compactDomain(string $value): string
    {
        $d = trim($value);
        $d = preg_replace('~^https?://~i', '', $d);
        $d = preg_replace('~/.*$~', '', $d);          // отрезаем путь целиком
        $d = trim($d, '.');

        $suffix = '.' . self::ZONE;
        if (str_ends_with(strtolower($d), $suffix)) {
            return substr($d, 0, -strlen($suffix));
        }
        return $d;
    }

    /** Приводим номер кабинета или домен к https://…/api/v1/. */
    public static function normalizeBase(string $domain): string
    {
        $d = self::compactDomain($domain);

        if ($d === '') {
            throw new RuntimeException('Не указан кабинет FUSIONPOS');
        }

        // Номер кабинета дописываем до полного адреса сами: в FUSIONPOS
        // кабинет известен номером, и требовать хвост было бы лишней работой
        if (!str_contains($d, '.')) {
            $d .= '.' . self::ZONE;
        }

        return "https://{$d}/api/v1/";
    }

    private function http(): PendingRequest
    {
        return Http::withToken($this->token)
            ->acceptJson()
            ->timeout(self::TIMEOUT)
            ->retry(2, 500, throw: false);
    }

    /**
     * GET с человеческими ошибками: наружу должно уйти «проверьте токен»,
     * а не «Client error: 401».
     */
    public function get(string $path, array $query = []): array
    {
        try {
            $response = $this->http()->get($this->baseUrl . ltrim($path, '/'), $query);
        } catch (ConnectionException) {
            // Наружу не должно уходить «cURL error 28» со ссылкой на libcurl:
            // человеку нужно знать, что проверить, а не как называется ошибка
            throw new RuntimeException(
                'Не удалось связаться с ' . parse_url($this->baseUrl, PHP_URL_HOST) .
                ' — проверьте домен кабинета и доступность сервера'
            );
        }

        if ($response->status() === 401 || $response->status() === 403) {
            throw new RuntimeException('FUSIONPOS не принял токен — проверьте его и права пользователя');
        }
        if ($response->status() === 404) {
            throw new RuntimeException("FUSIONPOS: адрес {$path} не найден — проверьте домен кабинета");
        }
        if ($response->failed()) {
            $msg = data_get($response->json(), 'message') ?: $response->status();
            throw new RuntimeException("FUSIONPOS ответил ошибкой: {$msg}");
        }

        return (array) $response->json();
    }

    /**
     * Постраничный обход списка. Колбэк получает пачку элементов.
     *
     * Ходим страницами, а не `pagination=false`: на большом периоде выгрузка
     * целиком может не влезть ни в ответ сервера, ни в нашу память.
     */
    public function each(string $path, array $query, callable $handler): int
    {
        $page  = 1;
        $total = 0;

        do {
            $body = $this->get($path, $query + ['page' => $page, 'per-page' => self::PER_PAGE]);

            $items = $body['items'] ?? [];
            if (!is_array($items)) break;

            $handler($items);
            $total += count($items);

            $pageCount = (int) data_get($body, '_meta.pageCount', 1);
            $page++;
        } while ($page <= $pageCount && $page <= self::MAX_PAGES && $items !== []);

        return $total;
    }

    /** Короткий пробный запрос — есть ли связь и принят ли токен. */
    public function ping(): array
    {
        return $this->get('warehouses', ['per-page' => 1]);
    }
}
