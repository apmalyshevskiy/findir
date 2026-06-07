<?php

namespace App\Services\Acquiring;

use Illuminate\Support\Facades\DB;

/**
 * Единый источник правды по правилам эквайринг-свода.
 *
 *  - дефолты (defaults) — кладутся в settings новому тенанту (сидер) и
 *    существующим (миграция-бэкафилл);
 *  - load() — читает и валидирует правила из settings.acquiring_fee_rules
 *    конкретного тенанта; парсер использует только их (без фолбэка в код);
 *  - validate() — нормализация/проверка перед записью (UI/контроллер).
 *
 * Правило: ['bank' => string, 'marker' => string,
 *           'amount_format' => 'rub_kop'|'dot', 'is_active' => bool].
 * Сырой regex не хранится: ClientBankExchangeParser собирает его из
 * marker + amount_format, поэтому пользователь не вводит регулярки.
 */
class AcquiringFeeRules
{
    public const SETTING_KEY = 'acquiring_fee_rules';

    /** Допустимые форматы суммы. */
    public const FORMATS = ['rub_kop', 'dot'];

    /**
     * Дефолтные правила. Проверены на реальных выписках:
     *   tbank — "Сумма комиссии 2534 руб. 77 коп."
     *   alfa  — "... К.1794.86 ..." (рубли.копейки через точку)
     *   sber  — "Комиссия 1 511.16 (в т.ч. НДС ...)" (пробел-тысячи, сумма сразу после маркера)
     */
    public static function defaults(): array
    {
        return [
            ['bank' => 'tbank', 'marker' => 'Сумма комиссии', 'amount_format' => 'rub_kop', 'is_active' => true],
            ['bank' => 'alfa',  'marker' => 'К.',             'amount_format' => 'dot',     'is_active' => true],
            ['bank' => 'sber',  'marker' => 'Комиссия',       'amount_format' => 'dot',     'is_active' => true],
        ];
    }

    /** JSON дефолтов для записи в settings.value. */
    public static function defaultsJson(): string
    {
        return json_encode(self::defaults(), JSON_UNESCAPED_UNICODE);
    }

    /**
     * Прочитать правила тенанта из settings. На любой проблеме (нет ключа,
     * битый JSON) возвращает [] — парсинг выписки не падает, свод просто
     * не выполняется.
     *
     * @param string $conn Имя тенантного соединения.
     */
    public static function load(string $conn): array
    {
        try {
            $raw = DB::connection($conn)
                ->table('settings')
                ->where('key', self::SETTING_KEY)
                ->value('value');
        } catch (\Throwable $e) {
            return [];
        }

        if ($raw === null || $raw === '') {
            return [];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return [];
        }

        // Пропускаем только структурно валидные правила.
        $out = [];
        foreach ($decoded as $rule) {
            if (!is_array($rule)) {
                continue;
            }
            $marker = trim((string) ($rule['marker'] ?? ''));
            $format = (string) ($rule['amount_format'] ?? '');
            $bank   = trim((string) ($rule['bank'] ?? ''));
            if ($marker === '' || !in_array($format, self::FORMATS, true)) {
                continue;
            }
            $out[] = [
                'bank'          => $bank !== '' ? $bank : null,
                'marker'        => $marker,
                'amount_format' => $format,
                'is_active'     => array_key_exists('is_active', $rule) ? (bool) $rule['is_active'] : true,
            ];
        }

        return $out;
    }

    /**
     * Нормализовать и проверить набор правил перед сохранением.
     * Кидает \InvalidArgumentException с понятным сообщением при ошибке.
     *
     * @return array Очищенный набор, готовый к json_encode.
     */
    public static function validate(array $rules): array
    {
        $out = [];
        foreach ($rules as $i => $rule) {
            if (!is_array($rule)) {
                throw new \InvalidArgumentException("Правило #{$i}: ожидается объект.");
            }
            $bank   = trim((string) ($rule['bank'] ?? ''));
            $marker = trim((string) ($rule['marker'] ?? ''));
            $format = (string) ($rule['amount_format'] ?? '');

            if ($marker === '') {
                throw new \InvalidArgumentException("Правило #{$i}: marker не может быть пустым.");
            }
            if (!in_array($format, self::FORMATS, true)) {
                throw new \InvalidArgumentException(
                    "Правило #{$i}: amount_format должен быть одним из: " . implode(', ', self::FORMATS) . '.'
                );
            }

            $out[] = [
                'bank'          => $bank,
                'marker'        => $marker,
                'amount_format' => $format,
                'is_active'     => array_key_exists('is_active', $rule) ? (bool) $rule['is_active'] : true,
            ];
        }
        return $out;
    }

    /**
     * Идемпотентно проставить дефолты тенанту: пишем ТОЛЬКО если ключа ещё нет
     * (правки пользователя не затираем). Используется и сидером, и бэкафиллом.
     */
    public static function ensureDefaults(string $conn): void
    {
        $exists = DB::connection($conn)
            ->table('settings')
            ->where('key', self::SETTING_KEY)
            ->exists();

        if ($exists) {
            return;
        }

        DB::connection($conn)->table('settings')->insert([
            'key'        => self::SETTING_KEY,
            'value'      => self::defaultsJson(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
}
