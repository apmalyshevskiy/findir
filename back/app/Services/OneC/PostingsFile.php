<?php

namespace App\Services\OneC;

use RuntimeException;

/**
 * Разбор и проверка файла выгрузки проводок из 1С (формат findir-postings).
 *
 * Живёт отдельно от команды и от контроллера: этим же кодом будет читать файл
 * загрузка в интерфейсе, и расходиться двум разборам одного формата нельзя.
 *
 * Описание формата — в 1c/FORMAT.md.
 *
 * Ошибки делятся надвое. То, после чего читать нечего (не JSON, чужой формат,
 * будущая версия), — исключение. Беда в отдельной проводке — строка в списке
 * problems: человеку нужно увидеть все двадцать плохих строк сразу, а не
 * чинить их по одной, перезапуская выгрузку.
 */
final class PostingsFile
{
    /** Версия формата, которую этот код понимает */
    public const VERSION = 1;

    /** Сколько проблемных строк перечисляем поимённо, дальше — счётчиком */
    private const MAX_PROBLEMS = 50;

    /**
     * Разобрать содержимое файла.
     *
     * @return array{meta: array, entries: array, problems: array}
     */
    public static function parse(string $raw): array
    {
        // Блокнот и выгрузка с BOM: символ попадает в начало строки, и
        // json_decode возвращает null без объяснения причины
        $raw = preg_replace('/^\xEF\xBB\xBF/', '', $raw);

        if (trim($raw) === '') {
            throw new RuntimeException('Файл пуст');
        }

        $data = json_decode($raw, true);

        if (!is_array($data)) {
            throw new RuntimeException(
                'Файл не читается как JSON: ' . json_last_error_msg()
                . '. Обычно это обрыв закачки или выгрузка не до конца'
            );
        }

        $format = $data['format'] ?? null;
        if ($format !== 'findir-postings') {
            throw new RuntimeException(
                'Это не выгрузка проводок FINDIR: в поле format ожидалось '
                . '«findir-postings», а пришло ' . self::show($format)
            );
        }

        $version = (int) ($data['version'] ?? 0);
        if ($version > self::VERSION) {
            throw new RuntimeException(
                "Файл версии {$version}, а эта система понимает версию "
                . self::VERSION . '. Обновите FINDIR или выгрузите старой обработкой'
            );
        }

        if (!array_key_exists('entries', $data) || !is_array($data['entries'])) {
            throw new RuntimeException('В файле нет массива entries');
        }

        $entries  = [];
        $problems = [];

        foreach ($data['entries'] as $i => $row) {
            // Номер строки человеческий, с единицы: по нему человек ищет
            // проводку глазами в файле
            $line = $i + 1;

            if (!is_array($row)) {
                self::addProblem($problems, $line, 'проводка не является объектом');
                continue;
            }

            $entry = self::readEntry($row, $line, $problems);
            if ($entry !== null) $entries[] = $entry;
        }

        return [
            'meta' => [
                'version'      => $version,
                'source'       => $data['source'] ?? null,
                'organization' => $data['organization'] ?? null,
                'period'       => $data['period'] ?? null,
                'exported_at'  => $data['exported_at'] ?? null,
                'total_in_file' => count($data['entries']),
            ],
            'entries'  => $entries,
            'problems' => $problems,
        ];
    }

    /**
     * Сводка по разобранному файлу.
     *
     * Список встреченных счетов — не украшение: соответствие «счёт 1С → счёт
     * FINDIR» заполняется до загрузки, и заполнять его нужно ровно по тем
     * счетам, которые в файле реально есть.
     */
    public static function summary(array $file): array
    {
        $accounts = [];
        $kinds    = [];
        $total    = 0.0;
        $dateFrom = null;
        $dateTo   = null;

        foreach ($file['entries'] as $entry) {
            $total += $entry['amount'];

            foreach (['debit', 'credit'] as $side) {
                $code = $entry[$side]['account'];
                $accounts[$code] = ($accounts[$code] ?? 0) + 1;

                foreach ($entry[$side]['subconto'] as $sub) {
                    $kind = $sub['kind'];
                    $kinds[$kind] = ($kinds[$kind] ?? 0) + 1;
                }
            }

            $date = substr($entry['date'], 0, 10);
            if ($dateFrom === null || $date < $dateFrom) $dateFrom = $date;
            if ($dateTo   === null || $date > $dateTo)   $dateTo   = $date;
        }

        // Счета по коду, а не по частоте: человек будет сверять их с планом
        // счетов 1С, а тот отсортирован по коду
        uksort($accounts, 'strnatcmp');
        arsort($kinds);

        return [
            'count'      => count($file['entries']),
            'amount'     => round($total, 2),
            'date_from'  => $dateFrom,
            'date_to'    => $dateTo,
            'accounts'   => $accounts,
            'subconto'   => $kinds,
        ];
    }

    // ── Разбор одной проводки ─────────────────────────────────────────────────

    private static function readEntry(array $row, int $line, array &$problems): ?array
    {
        $bad = false;

        $id = trim((string) ($row['id'] ?? ''));
        if ($id === '') {
            self::addProblem($problems, $line, 'пустой id — по нему ловятся повторные загрузки');
            $bad = true;
        }

        $date = self::readDate($row['date'] ?? null);
        if ($date === null) {
            self::addProblem($problems, $line, 'дата пустая или не в формате ГГГГ-ММ-ДД');
            $bad = true;
        }

        // Строку с суммой не принимаем молча: «1 200,50» из Excel разобралось бы
        // как 1, и это никак бы себя не проявило
        $amount = $row['amount'] ?? null;
        if (!is_int($amount) && !is_float($amount)) {
            self::addProblem($problems, $line, 'сумма не число: ' . self::show($amount));
            $bad = true;
        }

        $debit  = self::readSide($row['debit']  ?? null, 'дебет',  $line, $problems, $bad);
        $credit = self::readSide($row['credit'] ?? null, 'кредит', $line, $problems, $bad);

        if ($bad) return null;

        return [
            'id'       => $id,
            'date'     => $date,
            'document' => is_array($row['document'] ?? null) ? $row['document'] : null,
            'content'  => self::text($row['content'] ?? null),
            'amount'   => (float) $amount,
            'debit'    => $debit,
            'credit'   => $credit,
            'line'     => $line,
        ];
    }

    private static function readSide($side, string $name, int $line, array &$problems, bool &$bad): ?array
    {
        if (!is_array($side)) {
            self::addProblem($problems, $line, "нет стороны «{$name}»");
            $bad = true;
            return null;
        }

        $account = trim((string) ($side['account'] ?? ''));
        if ($account === '') {
            self::addProblem($problems, $line, "у стороны «{$name}» пустой счёт");
            $bad = true;
        }

        $subconto = [];
        foreach ((array) ($side['subconto'] ?? []) as $sub) {
            if (!is_array($sub)) continue;

            $kind = self::text($sub['kind'] ?? null);
            $sname = self::text($sub['name'] ?? null);

            // Субконто без вида или без имени сопоставлять не с чем. Это не
            // повод терять всю проводку — теряем только это субконто
            if ($kind === null || $sname === null) {
                self::addProblem($problems, $line, "у стороны «{$name}» субконто без вида или имени — пропущено");
                continue;
            }

            $subconto[] = [
                'kind' => $kind,
                'name' => $sname,
                'code' => self::text($sub['code'] ?? null),
                'inn'  => self::text($sub['inn'] ?? null),
            ];
        }

        $quantity = $side['quantity'] ?? null;

        return [
            'account'  => $account,
            'quantity' => (is_int($quantity) || is_float($quantity)) ? (float) $quantity : null,
            'subconto' => $subconto,
        ];
    }

    /** Дата в «Y-m-d H:i:s» или null, если разобрать не вышло */
    private static function readDate($value): ?string
    {
        if (!is_string($value) || trim($value) === '') return null;

        $value = trim($value);

        // Принимаем и «2026-09-05», и «2026-09-05T14:20:00»: в первом случае
        // время нулевое. Пояс не ждём — 1С отдаёт местное время
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})([T ](\d{2}):(\d{2})(:(\d{2}))?)?$/', $value, $m)) {
            return null;
        }

        if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1])) return null;

        $time = isset($m[5])
            ? sprintf('%02d:%02d:%02d', (int) $m[5], (int) $m[6], (int) ($m[8] ?? 0))
            : '00:00:00';

        return "{$m[1]}-{$m[2]}-{$m[3]} {$time}";
    }

    private static function text($value): ?string
    {
        if (!is_scalar($value)) return null;

        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    private static function addProblem(array &$problems, int $line, string $what): void
    {
        if (count($problems) < self::MAX_PROBLEMS) {
            $problems[] = ['line' => $line, 'message' => $what];
            return;
        }

        // Дальше только считаем: тысяча одинаковых жалоб не помогает
        $last = count($problems) - 1;
        if (($problems[$last]['line'] ?? null) === null) {
            $problems[$last]['more']++;
            return;
        }

        $problems[] = ['line' => null, 'message' => 'и ещё', 'more' => 1];
    }

    private static function show($value): string
    {
        if ($value === null) return 'ничего';
        if (is_scalar($value)) return '«' . $value . '»';

        return 'значение типа ' . gettype($value);
    }
}
