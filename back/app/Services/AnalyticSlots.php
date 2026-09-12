<?php

namespace App\Services;

/**
 * Слоты аналитики счёта: какие справочники принимает каждый из трёх.
 *
 * Слот хранит не тип, а НАБОР типов. Четыре состояния:
 *   null            — слота нет, поля в операции не будет;
 *   'partner'       — один справочник, как было всегда;
 *   'partner,employee' — только эти два;
 *   'any'           — любой справочник.
 *
 * «Любой» — отдельное слово, а не перечисление всех восьми типов: появится
 * девятый справочник, и счета с `any` примут его сами, а перечисление пришлось
 * бы обходить руками.
 *
 * Правило выбора слота жило в шести местах — в разборе вопросов к ИИ, в
 * массовой правке, в оборотке, в импорте из 1С — и успело разойтись: где-то
 * учитывалось значение, лежащее в необъявленном слоте, где-то нет. Теперь оно
 * здесь одно.
 */
final class AnalyticSlots
{
    /** Слот принимает аналитику любого типа */
    public const ANY = 'any';

    /** Справочники, которые может объявить счёт */
    public const TYPES = ['partner', 'employee', 'department', 'cash', 'flow', 'expenses', 'product', 'revenue'];

    /** Номера слотов у счёта */
    public const SLOTS = [1, 2, 3];

    /**
     * Номер слота из токена группировки: `'slot2'` → 2, всё остальное → null.
     *
     * Оборотка умеет разворачивать счёт не только по справочнику, но и по
     * самому слоту — «Аналитика 2» целиком, какие бы справочники в ней ни
     * лежали. Токен ходит там же, где типы аналитик, поэтому и разбирается
     * рядом с ними.
     */
    public static function slotToken(?string $value): ?int
    {
        if ($value === null || !preg_match('/^slot([123])$/', $value, $m)) return null;

        return (int) $m[1];
    }

    /** Сырое значение слота (`'partner,employee'`, `'any'`, null) */
    public static function declared($account, int $slot): ?string
    {
        $key   = "info_{$slot}_type";
        $value = is_array($account) ? ($account[$key] ?? null) : ($account->{$key} ?? null);

        return $value !== null && $value !== '' ? (string) $value : null;
    }

    public static function isAny(?string $declared): bool
    {
        return $declared === self::ANY;
    }

    /** Набор типов из объявления. Для `any` — все известные типы */
    public static function parse(?string $declared): array
    {
        if ($declared === null || $declared === '') return [];
        if (self::isAny($declared))                 return self::TYPES;

        $types = array_filter(
            array_map('trim', explode(',', $declared)),
            fn($t) => in_array($t, self::TYPES, true)
        );

        return array_values(array_unique($types));
    }

    /** Набор типов конкретного слота счёта */
    public static function types($account, int $slot): array
    {
        return self::parse(self::declared($account, $slot));
    }

    /** Принимает ли слот с таким объявлением аналитику этого типа */
    public static function accepts(?string $declared, ?string $type): bool
    {
        if (!$type) return false;
        if (self::isAny($declared)) return true;

        return in_array($type, self::parse($declared), true);
    }

    /**
     * Номер слота (1|2|3) под аналитику этого типа или null.
     *
     * Чем у́же слот, тем он важнее: сначала объявленный ровно под этот тип,
     * потом набор из нескольких, потом «любой». Иначе у счёта со слотами
     * «контрагент» и «любой» контрагент уезжал бы во второй, мимо
     * предназначенного, и первый стоял бы пустым.
     */
    public static function slotFor($account, ?string $type): ?int
    {
        return self::slotsFor($account, $type)[0] ?? null;
    }

    /**
     * Все слоты, принимающие этот тип, в порядке убывания точности.
     *
     * Нужно тем, кто раскладывает несколько аналитик сразу: если лучший слот
     * уже занят, берётся следующий подходящий. Счёт вправе объявить один тип
     * дважды — например, двух контрагентов в разных ролях.
     */
    public static function slotsFor($account, ?string $type): array
    {
        if (!$type) return [];

        $exact = $list = $any = [];

        foreach (self::SLOTS as $n) {
            $declared = self::declared($account, $n);
            if ($declared === null) continue;

            if (self::isAny($declared)) { $any[] = $n; continue; }

            $types = self::parse($declared);
            if (!in_array($type, $types, true)) continue;

            if (count($types) === 1) $exact[] = $n;
            else                     $list[]  = $n;
        }

        return [...$exact, ...$list, ...$any];
    }

    /** Поле операции под аналитику этого типа: `info_2_id`, `in_info_2_id` */
    public static function fieldFor($account, ?string $type, string $side = ''): ?string
    {
        $slot = self::slotFor($account, $type);
        if (!$slot) return null;

        return ($side !== '' ? $side . '_' : '') . "info_{$slot}_id";
    }

    /** Все типы, которые счёт готов принять хоть в каком-то слоте */
    public static function acceptedTypes($account): array
    {
        $out = [];

        foreach (self::SLOTS as $n) {
            foreach (self::types($account, $n) as $type) $out[$type] = true;
        }

        return array_keys($out);
    }

    /**
     * Значение слота к записи в базу.
     *
     * Принимает и строку («any», «partner,employee»), и список — фронт присылает
     * набор массивом. Порядок приводим к порядку TYPES, чтобы одинаковые наборы
     * не различались написанием и сравнивались как строки.
     */
    public static function normalize($value): ?string
    {
        if ($value === null || $value === '' || $value === []) return null;

        if (is_string($value) && self::isAny(trim($value))) return self::ANY;

        $raw = is_array($value) ? $value : explode(',', (string) $value);

        // Список со словом «любой» внутри означает «любой»: набор из всех
        // справочников и «любой» — одно и то же, но «любой» переживёт девятый тип
        foreach ($raw as $item) {
            if (self::isAny(trim((string) $item))) return self::ANY;
        }

        $types = array_values(array_filter(
            self::TYPES,
            fn($t) => in_array($t, array_map(fn($v) => trim((string) $v), $raw), true)
        ));

        return $types ? implode(',', $types) : null;
    }
}
