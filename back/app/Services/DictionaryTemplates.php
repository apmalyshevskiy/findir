<?php

namespace App\Services;

use Database\Seeders\CategoryPostingSeeder;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Шаблоны наполнения справочников тенанта.
 *
 * При регистрации справочники больше не создаются: пустая база — это осознанный
 * старт, тенант сам решает, наполнять ли её и чем. Шаблон применяется кнопкой
 * «Заполнить» в разделе «Справочники».
 *
 * Шаблон — PHP-файл в database/templates/dictionaries. Ключ шаблона = имя файла.
 * Шаблон под бизнес-модель наследует базовый через `extends` и добавляет только
 * свою специфику — дерево ДДС при этом продолжается, а не дублируется.
 *
 * Применение идемпотентно: запись считается существующей по паре type+code, а
 * при пустом коде — по type+name (без учёта регистра). Повторное применение
 * ничего не дублирует и не затирает правки тенанта.
 */
final class DictionaryTemplates
{
    /** Защита от циклов в цепочке extends. */
    private const MAX_DEPTH = 5;

    public static function dir(): string
    {
        return database_path('templates/dictionaries');
    }

    /** Список шаблонов для выбора: ключ, название, описание, состав по типам. */
    public static function all(): array
    {
        $out = [];

        foreach (glob(self::dir() . '/*.php') ?: [] as $path) {
            $key = basename($path, '.php');
            $tpl = self::load($key);
            if ($tpl) {
                $out[] = [
                    'key'         => $tpl['key'],
                    'name'        => $tpl['name'],
                    'description' => $tpl['description'],
                    'extends'     => $tpl['extends'],
                    'total'       => count($tpl['items']),
                    'counts'      => self::countsByType($tpl['items']),
                ];
            }
        }

        // Базовый шаблон — первым, дальше по алфавиту названий
        usort($out, function ($a, $b) {
            if ($a['key'] === 'basic') return -1;
            if ($b['key'] === 'basic') return 1;
            return strcmp($a['name'], $b['name']);
        });

        return $out;
    }

    /**
     * Загрузить шаблон с раскрытым extends.
     * Возвращает ['key','name','description','extends','items'] или null.
     */
    public static function load(string $key, int $depth = 0): ?array
    {
        // Ключ приходит из URL — в путь пускаем только безопасные символы
        if (!preg_match('/^[a-z0-9_-]+$/', $key)) return null;
        if ($depth > self::MAX_DEPTH) {
            throw new RuntimeException("Циклическое наследование шаблонов справочников: {$key}");
        }

        $path = self::dir() . '/' . $key . '.php';
        if (!is_file($path)) return null;

        $tpl   = require $path;
        $items = $tpl['items'] ?? [];

        $parentKey = $tpl['extends'] ?? null;
        if ($parentKey) {
            $parent = self::load($parentKey, $depth + 1);
            if (!$parent) {
                throw new RuntimeException("Шаблон «{$key}» наследует несуществующий «{$parentKey}»");
            }
            // Родительские элементы идут первыми: на их key ссылается parent/default_expense
            $items = array_merge($parent['items'], $items);
        }

        return [
            'key'         => $key,
            'name'        => $tpl['name'] ?? $key,
            'description' => $tpl['description'] ?? '',
            'extends'     => $parentKey,
            'items'       => $items,
        ];
    }

    /**
     * Состав шаблона с пометкой, что уже есть в базе тенанта, — для предпросмотра.
     * Возвращает элементы в порядке файла, каждый с ключом `exists`.
     */
    public static function preview(string $key, string $connection): ?array
    {
        $tpl = self::load($key);
        if (!$tpl) return null;

        $existing = self::existingIndex($connection);

        $tpl['items'] = array_map(function (array $item) use ($existing) {
            return $item + ['exists' => self::findExisting($existing, $item) !== null];
        }, $tpl['items']);

        $tpl['counts'] = self::countsByType($tpl['items']);
        $tpl['total']  = count($tpl['items']);
        $tpl['new']    = count(array_filter($tpl['items'], fn($i) => !$i['exists']));

        return $tpl;
    }

    /**
     * Применить шаблон к базе тенанта.
     *
     * @param  string  $connection  имя соединения тенантной БД
     * @return array{created:int,skipped:int,by_type:array}
     */
    public static function apply(string $key, string $connection): array
    {
        $tpl = self::load($key);
        if (!$tpl) {
            throw new RuntimeException("Шаблон справочников «{$key}» не найден");
        }

        $db  = DB::connection($connection);
        $now = now();

        $existing = self::existingIndex($connection);
        $idByKey  = [];   // key шаблона => id записи в info
        $seq      = [];   // "type|parentId" => счётчик сортировки среди соседей
        $expenseLinks = []; // id созданной статьи ДДС => key статьи расхода

        $created = 0;
        $skipped = 0;
        $byType  = [];

        $db->transaction(function () use (
            $tpl, $db, $now, &$existing, &$idByKey, &$seq, &$expenseLinks,
            &$created, &$skipped, &$byType
        ) {
            foreach ($tpl['items'] as $item) {
                $type = $item['type'];
                $code = $item['code'] ?? null;

                $parentId = null;
                if (!empty($item['parent'])) {
                    $parentId = $idByKey[$item['parent']] ?? null;
                }

                $bucket = $type . '|' . ($parentId ?? 0);
                $order  = $item['sort_order'] ?? ($seq[$bucket] ?? 0);
                $seq[$bucket] = $order + 1;

                $byType[$type] ??= ['created' => 0, 'skipped' => 0];

                $found = self::findExisting($existing, $item);
                if ($found !== null) {
                    // Уже есть — не трогаем: у тенанта могли быть свои правки
                    if (!empty($item['key'])) $idByKey[$item['key']] = $found;
                    $skipped++;
                    $byType[$type]['skipped']++;
                    continue;
                }

                $id = $db->table('info')->insertGetId([
                    'name'        => $item['name'],
                    'type'        => $type,
                    'code'        => $code,
                    'description' => $item['description'] ?? null,
                    'inn'         => null,
                    'parent_id'   => $parentId,
                    'sort_order'  => $order,
                    'is_active'   => true,
                    'created_at'  => $now,
                    'updated_at'  => $now,
                ]);

                // Чтобы повтор внутри одного применения не создал дубль
                $existing[$type]['n:' . mb_strtolower($item['name'])] ??= $id;
                if ($code) $existing[$type]['c:' . mb_strtolower($code)] ??= $id;

                if (!empty($item['key'])) $idByKey[$item['key']] = $id;
                if (!empty($item['default_expense'])) $expenseLinks[$id] = $item['default_expense'];

                $created++;
                $byType[$type]['created']++;
            }

            // Связь «статья ДДС → статья расхода» — вторым проходом: статья расхода
            // могла быть создана позже, чем статья движения.
            foreach ($expenseLinks as $flowId => $expenseKey) {
                $expenseId = $idByKey[$expenseKey] ?? null;
                if ($expenseId) {
                    $db->table('info')->where('id', $flowId)->update([
                        'default_expense_id' => $expenseId,
                        'updated_at'         => $now,
                    ]);
                }
            }
        });

        // Карта разноски ищет статьи ДДС по имени: до наполнения справочников
        // строки создались с пустой статьёй — теперь их можно доразрешить.
        self::resolveCategoryPostings($connection);

        return ['created' => $created, 'skipped' => $skipped, 'by_type' => $byType];
    }

    // ── Вспомогательное ───────────────────────────────────────────────────────

    /** [type][ 'c:код' | 'n:имя' ] => id — по живым (не удалённым) записям. */
    private static function existingIndex(string $connection): array
    {
        $index = [];

        $rows = DB::connection($connection)->table('info')
            ->whereNull('deleted_at')
            ->get(['id', 'type', 'code', 'name']);

        foreach ($rows as $row) {
            $index[$row->type]['n:' . mb_strtolower($row->name)] ??= (int) $row->id;
            if ($row->code !== null && $row->code !== '') {
                $index[$row->type]['c:' . mb_strtolower($row->code)] ??= (int) $row->id;
            }
        }

        return $index;
    }

    /** Есть ли уже такая запись: сперва по коду, затем по имени. */
    private static function findExisting(array $index, array $item): ?int
    {
        $type = $item['type'];
        $code = $item['code'] ?? null;

        if ($code && isset($index[$type]['c:' . mb_strtolower($code)])) {
            return $index[$type]['c:' . mb_strtolower($code)];
        }

        return $index[$type]['n:' . mb_strtolower($item['name'])] ?? null;
    }

    private static function countsByType(array $items): array
    {
        $counts = [];
        foreach ($items as $item) {
            $counts[$item['type']] = ($counts[$item['type']] ?? 0) + 1;
        }
        return $counts;
    }

    private static function resolveCategoryPostings(string $connection): void
    {
        $prev = DB::getDefaultConnection();
        DB::setDefaultConnection($connection);
        try {
            (new CategoryPostingSeeder())->run();
        } finally {
            DB::setDefaultConnection($prev);
        }
    }
}
