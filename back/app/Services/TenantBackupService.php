<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use RuntimeException;

/**
 * Архивная копия данных тенанта: выгрузка и загрузка.
 *
 * Состав определяется «от обратного» — выгружаем все таблицы, кроме явно
 * исключённых. Так новая таблица попадёт в копию сама, и её не забудут добавить.
 *
 * Что НЕ входит и почему:
 *  - balance_changes — производная таблица, её ведут триггеры на operations.
 *    При загрузке она пересобирается сама; включи её в копию — обороты задвоятся.
 *  - токены и сессии — состояние входа, а не данные: после восстановления
 *    человек остаётся в системе с тем же токеном, и это правильно.
 *  - очереди и migrations — состояние среды, а не данные.
 *
 * Пользователи и должности ВХОДЯТ: копия обязана восстанавливать компанию
 * целиком, включая тех, кто в ней работает, и то, что каждому видно. Отсюда два
 * следствия, о которых нельзя молчать: в файле лежат хэши паролей (значит,
 * хранить его надо как пароль), а после восстановления пароли станут теми, что
 * были на момент копии. Того, кто выполняет восстановление, страхуем отдельно —
 * см. import().
 *
 * Копия старше схемы грузится: поля, которых в таблице уже нет, отбрасываются,
 * и в ответе сказано какие. Новые колонки при этом берут свои умолчания — так
 * копия, снятая месяц назад, остаётся пригодной после правок схемы.
 */
final class TenantBackupService
{
    public const FORMAT = 'findir-backup/1';

    private const EXCLUDED = [
        'balance_changes',                                   // производная от operations
        'personal_access_tokens',                            // состояние входа
        'password_reset_tokens', 'sessions',
        'jobs', 'job_batches', 'failed_jobs',                // очереди
        'migrations',                                        // состояние схемы
    ];

    /** История правок объектов: тяжёлая и нужна не всегда — отдельной галочкой */
    public const HISTORY_TABLE = 'object_versions';

    /**
     * Порядок загрузки: сначала то, на что ссылаются.
     * Таблицы из файла, которых здесь нет, грузятся после — в порядке файла.
     */
    private const RESTORE_ORDER = [
        'settings', 'roles', 'users', 'projects', 'balance_items', 'info',
        'category_postings', 'payment_classification_rules',
        'fund_schemes', 'funds', 'fund_plan_docs', 'fund_plan_lines',
        'budget_documents', 'budget_items', 'budget_opening_balances',
        'documents', 'document_items',
        'operation_templates',
        'integrations', 'integration_links', 'integration_runs',
        'operations',                                        // последним: триггеры соберут обороты
    ];

    /**
     * Поля, которые обнуляются при выгрузке.
     *
     * Токены доступа к чужим системам в скачиваемом файле — это утечка: копию
     * пересылают почтой и кладут в облако. После восстановления интеграция
     * останется со всеми настройками, но токен придётся ввести заново.
     */
    private const REDACTED = [
        'integrations' => ['credentials'],
    ];

    /** Сколько строк за раз пишем при загрузке. */
    private const CHUNK = 500;

    /**
     * Список таблиц, попадающих в копию.
     *
     * @param bool $withHistory включать ли историю правок объектов
     */
    public function tables(string $db, bool $withHistory = true): array
    {
        $all = array_map(
            fn($row) => array_values((array) $row)[0],
            DB::connection($db)->select('SHOW TABLES')
        );

        $skip = self::EXCLUDED;
        if (!$withHistory) $skip[] = self::HISTORY_TABLE;

        return array_values(array_diff($all, $skip));
    }

    /** Строк в каждой таблице — для показа состава перед выгрузкой. */
    public function counts(string $db): array
    {
        $out = [];
        foreach ($this->tables($db) as $t) {
            $out[$t] = DB::connection($db)->table($t)->count();
        }
        return $out;
    }

    /**
     * Выгрузка потоком, сразу в gzip.
     *
     * Держать весь архив в памяти нельзя — её на сервере мало, а операций много,
     * поэтому и JSON, и сжатие идут кусками: строки уходят в поток по мере чтения
     * из базы. Учётные данные — это в основном повторяющиеся числа и коды, они
     * жмутся раз в десять и больше.
     */
    public function streamTo(string $db, string $tenantId, bool $withHistory = true): void
    {
        $z = deflate_init(ZLIB_ENCODING_GZIP, ['level' => 6]);

        $emit = function (string $chunk) use ($z) {
            echo deflate_add($z, $chunk, ZLIB_NO_FLUSH);
        };

        $meta = [
            'format'      => self::FORMAT,
            'tenant'      => $tenantId,
            'created_at'  => now()->toIso8601String(),
            'app_version' => config('app.version', 'findir'),
            // Чтобы при загрузке было видно, полная копия или без истории:
            // иначе пустая история читалась бы как «правок не было»
            'history'     => $withHistory,
        ];

        $emit('{"meta":' . json_encode($meta, JSON_UNESCAPED_UNICODE) . ',"tables":{');

        $firstTable = true;
        foreach ($this->tables($db, $withHistory) as $table) {
            $emit(($firstTable ? '' : ',') . json_encode($table) . ':[');
            $firstTable = false;

            $firstRow = true;
            $q = DB::connection($db)->table($table);
            $hide = self::REDACTED[$table] ?? [];

            $write = function ($row) use (&$firstRow, $emit, $hide) {
                $row = (array) $row;
                foreach ($hide as $field) {
                    if (array_key_exists($field, $row)) $row[$field] = null;
                }
                $emit(($firstRow ? '' : ',') . json_encode($row, JSON_UNESCAPED_UNICODE));
                $firstRow = false;
            };

            // chunk требует ключ сортировки; где его нет — таблица маленькая
            if (Schema::connection($db)->hasColumn($table, 'id')) {
                $q->orderBy('id')->chunk(1000, function ($rows) use ($write) {
                    foreach ($rows as $row) $write($row);
                });
            } else {
                foreach ($q->get() as $row) $write($row);
            }

            $emit(']');
            if (ob_get_level() > 0) ob_flush();
            flush();
        }

        $emit('}}');
        echo deflate_add($z, '', ZLIB_FINISH);
    }

    /** Что внутри файла — без изменения данных. */
    public function inspect(array $payload): array
    {
        $meta = $payload['meta'] ?? [];
        if (($meta['format'] ?? null) !== self::FORMAT) {
            throw new RuntimeException('Это не архивная копия FINDIR или формат новее — загрузка отменена');
        }

        $tables = $payload['tables'] ?? [];
        if (!is_array($tables) || !$tables) {
            throw new RuntimeException('В файле нет данных');
        }

        $counts = [];
        foreach ($tables as $name => $rows) {
            $counts[$name] = is_array($rows) ? count($rows) : 0;
        }

        return [
            'tenant'     => $meta['tenant'] ?? '—',
            'created_at' => $meta['created_at'] ?? null,
            'counts'     => $counts,
            'total'      => array_sum($counts),
        ];
    }

    /**
     * Загрузка: данные тенанта заменяются содержимым файла.
     *
     * Всё в одной транзакции — оборванная загрузка не должна оставить половину базы.
     * Чистим DELETE, а не TRUNCATE: TRUNCATE в MySQL делает неявный commit и
     * разорвал бы транзакцию, а заодно не запустил бы триггеры на operations,
     * которые убирают за собой balance_changes.
     *
     * Пользователи и должности восстанавливаются наравне с остальным, но того,
     * кто нажал кнопку, страхуем: если в копии его учётной записи нет (завели
     * позже) — возвращаем её, а если пропала и её должность — возвращаем и
     * должность. Иначе человек восстановил бы компанию и в тот же миг закрыл
     * себе вход, а починить это было бы уже нечем.
     *
     * @param int|null $actorId кто восстанавливает
     */
    public function import(string $db, array $payload, ?int $actorId = null): array
    {
        $info   = $this->inspect($payload);
        $tables = $payload['tables'];

        // Снимок до чистки: пригодится, если копия о нём не знает
        $me = $actorId
            ? (array) (DB::connection($db)->table('users')->where('id', $actorId)->first() ?? [])
            : [];
        $myRole = !empty($me['role_id'])
            ? (array) (DB::connection($db)->table('roles')->where('id', $me['role_id'])->first() ?? [])
            : [];

        $known    = $this->tables($db);
        $ordered  = array_values(array_filter(self::RESTORE_ORDER, fn($t) => isset($tables[$t]) && in_array($t, $known, true)));
        $rest     = array_values(array_filter(array_keys($tables),
            fn($t) => in_array($t, $known, true) && !in_array($t, $ordered, true)));
        $ordered  = array_merge($ordered, $rest);

        $skipped  = array_values(array_diff(array_keys($tables), $ordered));
        $restored = [];
        $dropped  = [];
        $keptMe   = false;

        DB::connection($db)->transaction(function () use ($db, $ordered, $tables, $me, $myRole, &$restored, &$dropped, &$keptMe) {
            // Удаляем в обратном порядке — сначала зависимые
            foreach (array_reverse($ordered) as $table) {
                DB::connection($db)->table($table)->delete();
            }
            // Триггеры чистят обороты сами, но подчистим на случай осиротевших строк
            DB::connection($db)->table('balance_changes')->delete();

            foreach ($ordered as $table) {
                $rows = array_map(fn($r) => (array) $r, $tables[$table] ?? []);

                // Колонки, которых в сегодняшней схеме уже нет: копия снята до
                // того, как поле убрали или переименовали. Такие поля молча
                // отбрасываем — иначе INSERT падает на «Unknown column», и
                // копия месячной давности не грузится вовсе. Что отбросили,
                // говорим в ответе: человек должен знать, чего не вернулось
                $columns = array_flip(Schema::connection($db)->getColumnListing($table));

                foreach ($rows as $i => $row) {
                    $extra = array_diff_key($row, $columns);
                    if (!$extra) continue;

                    $dropped[$table] = array_values(array_unique(array_merge(
                        $dropped[$table] ?? [], array_keys($extra),
                    )));
                    $rows[$i] = array_intersect_key($row, $columns);
                }

                foreach (array_chunk($rows, self::CHUNK) as $chunk) {
                    DB::connection($db)->table($table)->insert($chunk);
                }
                $restored[$table] = count($rows);
            }

            $keptMe = $this->keepActor($db, $me, $myRole);
        });

        return [
            'restored' => $restored,
            'total'    => array_sum($restored),
            'skipped'  => $skipped,          // таблицы из файла, которых нет в базе
            'dropped'  => $dropped,          // поля из файла, которых нет в таблице
            'kept_me'  => $keptMe,           // пришлось ли вернуть учётку того, кто грузил
            'tenant'   => $info['tenant'],
        ];
    }

    /**
     * Вернуть на место того, кто восстанавливает, если копия о нём не знает.
     *
     * Проверяем и должность: восстановленный список должностей может не
     * содержать той, под которой человек работает, а без неё прав у него не
     * останется вовсе — Access считает пустые права «недонастроенной учёткой».
     *
     * @return bool пришлось ли что-то возвращать
     */
    private function keepActor(string $db, array $me, array $myRole): bool
    {
        if (!$me) return false;

        $users = DB::connection($db)->table('users');
        $kept  = false;

        if (!empty($myRole)) {
            $roles = DB::connection($db)->table('roles');
            if (!$roles->where('id', $myRole['id'])->exists()) {
                $roles->insert($myRole);
                $kept = true;
            }
        }

        if (!$users->where('id', $me['id'])->exists()) {
            $users->insert($me);
            $kept = true;
        }

        return $kept;
    }
}
