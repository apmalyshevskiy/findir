<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/**
 * Закрытые счета: что этому человеку не показывать.
 *
 * Права по разделам решают, пустят ли в раздел. Здесь — поперечный разрез:
 * какие счета из раздела вырезать. Кассиру нужны деньги и поставщики, но не
 * П335 «Расчёты с сотрудниками» и не финансовый результат — ни в списке
 * операций, ни в оборотке, ни через вопрос к ИИ.
 *
 * Список хранится у должности как отмеченные счета, а закрытым считается
 * отмеченный счёт вместе со всем поддеревом: закрыл группу — закрыл всё, что
 * в ней есть и что в ней появится.
 *
 * Пустой список — не «особый режим», а обычное состояние: у администратора и у
 * любой должности без ограничений ни один запрос не должен получить лишнего
 * условия. Поэтому все вызывающие сначала спрашивают isEmpty().
 */
final class AccountScope
{
    /** Кэш на запрос: скоуп спрашивают из десятка мест одного контроллера */
    private static array $cache = [];

    /** @param int[] $hidden раскрытые по иерархии bi_id */
    private function __construct(private array $hidden) {}

    public static function for(string $db, ?int $userId): self
    {
        if (!$userId) return new self([]);

        $key = $db . ':' . $userId;

        return self::$cache[$key] ??= new self(self::resolve($db, $userId));
    }

    /** Пустой скоуп — для мест, где пользователь не определяется (консоль, тесты) */
    public static function unrestricted(): self
    {
        return new self([]);
    }

    public static function forgetCache(): void
    {
        self::$cache = [];
    }

    public function isEmpty(): bool
    {
        return $this->hidden === [];
    }

    /** @return int[] */
    public function hiddenIds(): array
    {
        return $this->hidden;
    }

    public function hides(?int $biId): bool
    {
        return $biId !== null && in_array((int) $biId, $this->hidden, true);
    }

    /** Есть ли среди переданных счетов хоть один закрытый */
    public function hidesAny(array $biIds): bool
    {
        foreach ($biIds as $id) {
            if ($this->hides($id !== null ? (int) $id : null)) return true;
        }

        return false;
    }

    /**
     * Убрать из выборки строки по закрытым счетам.
     *
     * Возвращает тот же запрос, чтобы вставать в цепочку. При пустом списке не
     * трогает запрос вовсе — план выполнения остаётся прежним.
     */
    public function exclude($query, string $column = 'bi_id')
    {
        if ($this->isEmpty()) return $query;

        return $query->whereNotIn($column, $this->hidden);
    }

    /**
     * Список закрытых счетов должности, раскрытый по иерархии.
     *
     * Дерево счетов маленькое (десятки строк), поэтому раскрываем его в PHP —
     * рекурсивный запрос ради двух уровней не нужен.
     */
    private static function resolve(string $db, int $userId): array
    {
        $raw = DB::connection($db)->table('users as u')
            ->leftJoin('roles as r', 'r.id', '=', 'u.role_id')
            ->where('u.id', $userId)
            ->value('r.denied_accounts');

        $marked = array_values(array_filter(array_map('intval', (array) (json_decode((string) $raw, true) ?: []))));

        if (!$marked) return [];

        $parents = DB::connection($db)->table('balance_items')
            ->pluck('parent_id', 'id');

        $hidden = array_fill_keys($marked, true);

        // Потомок закрытого счёта закрыт: поднимаемся по родителям каждого
        // счёта и смотрим, не упрёмся ли в отмеченный
        foreach ($parents as $id => $parentId) {
            $cur   = $parentId;
            $guard = 0;
            while ($cur && $guard++ < 50) {
                if (isset($hidden[(int) $cur])) {
                    $hidden[(int) $id] = true;
                    break;
                }
                $cur = $parents[$cur] ?? null;
            }
        }

        return array_map('intval', array_keys($hidden));
    }
}
