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
 *  - users, токены, сессии — доступы. Копия про учётные данные компании, а не
 *    про то, кто в неё входит: восстановление не должно менять пароли и уж тем
 *    более выкладывать их хэши в скачиваемый файл. Пользователи при загрузке
 *    не трогаются, иначе после восстановления никто не смог бы войти.
 *  - очереди и migrations — состояние среды, а не данные.
 */
final class TenantBackupService
{
    public const FORMAT = 'findir-backup/1';

    private const EXCLUDED = [
        'balance_changes',                                   // производная от operations
        'users', 'personal_access_tokens',                   // доступы
        'password_reset_tokens', 'sessions',
        'jobs', 'job_batches', 'failed_jobs',                // очереди
        'migrations',                                        // состояние схемы
    ];

    /**
     * Порядок загрузки: сначала то, на что ссылаются.
     * Таблицы из файла, которых здесь нет, грузятся после — в порядке файла.
     */
    private const RESTORE_ORDER = [
        'settings', 'projects', 'balance_items', 'info',
        'category_postings', 'payment_classification_rules',
        'fund_schemes', 'funds', 'fund_plan_docs', 'fund_plan_lines',
        'budget_documents', 'budget_items', 'budget_opening_balances',
        'documents', 'document_items',
        'operation_templates',
        'operations',                                        // последним: триггеры соберут обороты
    ];

    /** Сколько строк за раз пишем при загрузке. */
    private const CHUNK = 500;

    /** Список таблиц, попадающих в копию. */
    public function tables(string $db): array
    {
        $all = array_map(
            fn($row) => array_values((array) $row)[0],
            DB::connection($db)->select('SHOW TABLES')
        );

        return array_values(array_diff($all, self::EXCLUDED));
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
    public function streamTo(string $db, string $tenantId): void
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
        ];

        $emit('{"meta":' . json_encode($meta, JSON_UNESCAPED_UNICODE) . ',"tables":{');

        $firstTable = true;
        foreach ($this->tables($db) as $table) {
            $emit(($firstTable ? '' : ',') . json_encode($table) . ':[');
            $firstTable = false;

            $firstRow = true;
            $q = DB::connection($db)->table($table);

            // chunk требует ключ сортировки; где его нет — таблица маленькая
            if (Schema::connection($db)->hasColumn($table, 'id')) {
                $q->orderBy('id')->chunk(1000, function ($rows) use (&$firstRow, $emit) {
                    foreach ($rows as $row) {
                        $emit(($firstRow ? '' : ',') . json_encode($row, JSON_UNESCAPED_UNICODE));
                        $firstRow = false;
                    }
                });
            } else {
                foreach ($q->get() as $row) {
                    $emit(($firstRow ? '' : ',') . json_encode($row, JSON_UNESCAPED_UNICODE));
                    $firstRow = false;
                }
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
     */
    public function import(string $db, array $payload): array
    {
        $info   = $this->inspect($payload);
        $tables = $payload['tables'];

        $known    = $this->tables($db);
        $ordered  = array_values(array_filter(self::RESTORE_ORDER, fn($t) => isset($tables[$t]) && in_array($t, $known, true)));
        $rest     = array_values(array_filter(array_keys($tables),
            fn($t) => in_array($t, $known, true) && !in_array($t, $ordered, true)));
        $ordered  = array_merge($ordered, $rest);

        $skipped  = array_values(array_diff(array_keys($tables), $ordered));
        $restored = [];

        DB::connection($db)->transaction(function () use ($db, $ordered, $tables, &$restored) {
            // Удаляем в обратном порядке — сначала зависимые
            foreach (array_reverse($ordered) as $table) {
                DB::connection($db)->table($table)->delete();
            }
            // Триггеры чистят обороты сами, но подчистим на случай осиротевших строк
            DB::connection($db)->table('balance_changes')->delete();

            foreach ($ordered as $table) {
                $rows = array_map(fn($r) => (array) $r, $tables[$table] ?? []);
                foreach (array_chunk($rows, self::CHUNK) as $chunk) {
                    DB::connection($db)->table($table)->insert($chunk);
                }
                $restored[$table] = count($rows);
            }
        });

        return [
            'restored' => $restored,
            'total'    => array_sum($restored),
            'skipped'  => $skipped,          // таблицы из файла, которых нет в базе
            'tenant'   => $info['tenant'],
        ];
    }
}
