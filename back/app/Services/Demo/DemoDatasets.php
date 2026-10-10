<?php

namespace App\Services\Demo;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Наборы демо-данных: чем можно наполнить чистую компанию.
 *
 * Реестр, а не одна команда, потому что бизнес-моделей будет несколько:
 * торговля сегодня, производство и общепит потом. Набор описан здесь, а делает
 * работу консольная команда — так один и тот же генератор зовётся и руками из
 * консоли, и кнопкой из интерфейса, и расходиться им негде.
 *
 * Недоделанные наборы перечислены с `ready => false` намеренно: в окне они
 * видны серыми, и человек понимает, что это не всё, а не что торговля — всё,
 * на что программа способна.
 *
 * Заполнение разрешено **только чистой базе**. Это не формальность: генератор
 * заводит свои справочники и остатки, и поверх живого учёта получилась бы
 * вторая компания в одной базе, которую потом не разделить.
 */
final class DemoDatasets
{
    /** Таблицы, по которым судим, что база ещё чистая */
    private const LEDGER = ['operations', 'documents', 'budget_documents'];

    /** @return array<string, array<string, mixed>> */
    public static function all(): array
    {
        return [
            'trade' => [
                'key'         => 'trade',
                'name'        => 'Оптовая торговля',
                'description' => 'Опт и дистрибуция: год операций, дебиторка и кредиторка, кредитная линия, бюджеты и платёжный календарь.',
                'ready'       => true,
                'command'     => 'demo:trading',
                'about'       => [
                    'выручка около 300 млн ₽ за 2026 год, чистая прибыль 8–9%',
                    'отгрузки и закупки накладными в суммовом учёте',
                    'дебиторка и кредиторка по срокам оплаты, кредитная линия',
                    'БДР и БДДС на год с планом по месяцам',
                    'платёжный календарь на декабрь и январь, с кассовым разрывом',
                ],
            ],

            'manufacturing' => [
                'key'         => 'manufacturing',
                'name'        => 'Производство',
                'description' => 'Сырьё, выпуск продукции, себестоимость переработки, незавершёнка.',
                'ready'       => false,
                'command'     => null,
                'about'       => [],
            ],

            'horeca' => [
                'key'         => 'horeca',
                'name'        => 'Общепит',
                'description' => 'Точки продаж, кассовые смены, эквайринг, продукты и списания.',
                'ready'       => false,
                'command'     => null,
                'about'       => [],
            ],
        ];
    }

    public static function find(string $key): ?array
    {
        return self::all()[$key] ?? null;
    }

    /**
     * Что уже есть в базе: таблица → сколько записей. Пусто — база чистая.
     *
     * @return array<string, int>
     */
    public static function occupied(string $db): array
    {
        $out = [];

        foreach (self::LEDGER as $table) {
            if (!Schema::connection($db)->hasTable($table)) continue;

            $q = DB::connection($db)->table($table);
            if (Schema::connection($db)->hasColumn($table, 'deleted_at')) $q->whereNull('deleted_at');

            $n = $q->count();
            if ($n) $out[$table] = $n;
        }

        return $out;
    }

    public static function isEmpty(string $db): bool
    {
        return self::occupied($db) === [];
    }

    /** «операций: 128, документов: 12» — для отказа человеку */
    public static function describe(array $occupied): string
    {
        $labels = ['operations' => 'операций', 'documents' => 'документов', 'budget_documents' => 'бюджетов'];

        $parts = [];
        foreach ($occupied as $table => $n) {
            $parts[] = ($labels[$table] ?? $table) . ': ' . $n;
        }

        return implode(', ', $parts);
    }
}
