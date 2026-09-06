<?php

namespace App\Services\OneC;

use App\Models\Tenant\Operation;
use App\Services\AccountScope;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Проводки 1С → операции FINDIR.
 *
 * Одна проводка становится одной операцией: дебет ложится в in_*, кредит в
 * out_*. Модель у нас та же двусторонняя, поэтому разбирать проводку на части
 * не нужно — нужно только перевести счета и аналитику на наши справочники.
 *
 * Два правила переноса заданы учётной политикой, а не файлом:
 *
 *  1. Счета сопоставляются вручную и один раз (таблица onec_account_map).
 *     Угадывать соответствие «10.01 → материалы» нельзя: план счетов FINDIR
 *     управленческий, и один счёт 1С у разных компаний ложится по-разному.
 *     Проводка с несопоставленным счётом не грузится, а показывается как
 *     несопоставленная — молча пропустить её значило бы потерять деньги.
 *
 *  2. Аналитика сопоставляется по наименованию, и только та, для которой в
 *     FINDIR есть слот подходящего типа. Остального в учёте нет — субконто
 *     просто не переносится. Заводить справочники за человека мы не будем:
 *     от «Договоры контрагентов» и документов-регистраторов, попавших в
 *     субконто, справочник зарос бы мусором за первую же загрузку.
 */
final class PostingsImporter
{
    /** Метка источника в операциях: по ней же ищутся ранее загруженные. */
    public const SOURCE = 'onec';

    /** Сколько предупреждений возвращаем: дальше это шум, а не помощь. */
    private const MAX_WARNINGS = 50;

    /** account 1С → bi_id */
    private array $map = [];

    /** bi_id → строка плана счетов */
    private array $bi = [];

    /** тип аналитики → [нормализованное имя => id] */
    private array $byName = [];

    /** тип аналитики → [ИНН => id] */
    private array $byInn = [];

    private array $warnings = [];

    public function __construct(
        private string $conn,
        private AccountScope $scope,
        private ?string $lockDate = null,
        private ?int $projectId = null,
    ) {
        $this->loadMap();
        $this->loadInfo();
    }

    // ─── Просмотр ────────────────────────────────────────────────────────────

    /**
     * Что получится из файла — без единой записи в базу.
     *
     * @param array $file результат PostingsFile::parse()
     */
    public function preview(array $file): array
    {
        $rows     = [];
        $accounts = [];

        foreach ($file['entries'] as $entry) {
            $row    = $this->build($entry);
            $rows[] = $row;

            foreach (['debit', 'credit'] as $side) {
                $code = $entry[$side]['account'];
                $accounts[$code] ??= ['account' => $code, 'count' => 0];
                $accounts[$code]['count']++;
            }
        }

        // Счета — по коду: человек сверяет их с планом счетов 1С, а тот
        // отсортирован по коду, а не по частоте встречаемости
        uksort($accounts, 'strnatcmp');

        foreach ($accounts as $code => &$a) {
            $biId = $this->map[$code] ?? null;
            $item = $biId ? ($this->bi[$biId] ?? null) : null;

            $a['bi_id']  = $item ? (int) $biId : null;
            $a['bi']     = $item ? $item->code . ' ' . $item->name : null;
            $a['hidden'] = $biId !== null && $item === null;   // сопоставлен, но закрыт ролью
        }
        unset($a);

        return [
            'rows'     => $rows,
            'accounts' => array_values($accounts),
            'stats'    => $this->stats($rows),
        ];
    }

    // ─── Загрузка ────────────────────────────────────────────────────────────

    /**
     * Создать или обновить операции.
     *
     * $only — идентификаторы отмеченных проводок; null означает «всё, что
     * можно взять». Отмеченное грузится, даже если не менялось: раз человек
     * выбрал строку руками, «пропущено» — не тот ответ, которого он ждёт.
     */
    public function import(array $file, ?array $only = null): array
    {
        $pick   = $only === null ? null : array_flip($only);
        $counts = ['created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0];

        if (!$this->projectId) {
            return $counts + ['warnings' => ['Не выбран проект — операции некуда складывать']];
        }

        foreach ($file['entries'] as $entry) {
            $row = $this->build($entry);

            if ($pick !== null && !isset($pick[$row['id']])) continue;

            if ($row['status'] === 'loaded' && $pick === null) {
                $counts['skipped']++;
                continue;
            }

            if (in_array($row['status'], ['unmapped', 'forbidden', 'locked'], true)) {
                $counts['failed']++;
                $this->warn($this->label($row) . ' — ' . $row['problem']);
                continue;
            }

            try {
                $this->save($row, $counts);
            } catch (\Throwable $e) {
                $counts['failed']++;
                $this->warn($this->label($row) . ' — ' . $e->getMessage());
            }
        }

        return $counts + ['warnings' => $this->warnings];
    }

    private function save(array $row, array &$counts): void
    {
        $values = [
            'date'          => $row['date'],
            'project_id'    => $this->projectId,
            'amount'        => $row['amount'],
            'in_bi_id'      => $row['debit']['bi_id'],
            'out_bi_id'     => $row['credit']['bi_id'],
            'in_quantity'   => $row['debit']['quantity'],
            'out_quantity'  => $row['credit']['quantity'],
            'quantity'      => $row['debit']['quantity'] ?: $row['credit']['quantity'],
            'note'          => $row['note'],
            'content'       => $row['content'],
            'source'        => self::SOURCE,
            'is_posted'     => true,
            'external_id'   => $row['id'],
            'external_date' => $row['external_date'],
        ];

        foreach ([1, 2, 3] as $slot) {
            $values["in_info_{$slot}_id"]  = $row['debit']['info'][$slot - 1];
            $values["out_info_{$slot}_id"] = $row['credit']['info'][$slot - 1];
        }

        $existing = $row['operation_id']
            ? Operation::on($this->conn)->find($row['operation_id'])
            : null;

        if ($existing) {
            $existing->fill($values)->save();
            $counts['updated']++;
            return;
        }

        $op = (new Operation)->setConnection($this->conn);
        $op->fill($values)->save();
        $counts['created']++;
    }

    // ─── Одна проводка ───────────────────────────────────────────────────────

    /** Что получится из проводки и можно ли её взять. */
    private function build(array $entry): array
    {
        $debit  = $this->side($entry['debit']);
        $credit = $this->side($entry['credit']);

        $row = [
            'id'            => $entry['id'],
            'date'          => $entry['date'],
            'external_date' => $this->documentDate($entry),
            'amount'        => $entry['amount'],
            'document'      => $this->documentLabel($entry),
            'content'       => $this->content($entry),
            'note'          => $this->note($entry),
            'debit'         => $debit,
            'credit'        => $credit,
            'operation_id'  => null,
            'problem'       => null,
        ];

        // Порядок проверок — от непоправимого к поправимому: пока счёт не
        // сопоставлен, говорить про закрытый период рано
        if ($debit['bi_id'] === null || $credit['bi_id'] === null) {
            $missing = [];
            if ($debit['bi_id']  === null) $missing[] = $debit['account'];
            if ($credit['bi_id'] === null) $missing[] = $credit['account'];

            $row['status']  = $debit['hidden'] || $credit['hidden'] ? 'forbidden' : 'unmapped';
            $row['problem'] = $row['status'] === 'forbidden'
                ? 'счёт закрыт для вашей должности'
                : 'счёт 1С не сопоставлен: ' . implode(', ', array_unique($missing));

            return $row;
        }

        [$status, $operationId] = $this->compare($row);

        $row['operation_id'] = $operationId;
        $row['status']       = $status;

        if ($status !== 'loaded' && $this->locked($entry['date'])) {
            $row['status']  = 'locked';
            $row['problem'] = 'период закрыт по ' . $this->lockDate . ' включительно';
        }

        return $row;
    }

    /** Одна сторона проводки: счёт, количество и аналитика по слотам. */
    private function side(array $side): array
    {
        $code = $side['account'];
        $biId = $this->map[$code] ?? null;
        $item = $biId ? ($this->bi[$biId] ?? null) : null;

        $out = [
            'account'  => $code,
            'bi_id'    => $item ? (int) $biId : null,
            'bi'       => $item ? $item->code . ' ' . $item->name : null,
            // Счёт сопоставлен, но закрыт ролью: это не «забыли настроить»,
            // и предлагать человеку сопоставить его заново незачем
            'hidden'   => $biId !== null && $item === null,
            'info'     => [null, null, null],
            'matched'  => [],
            'skipped'  => [],
            'quantity' => 0.0,
        ];

        if (!$item) return $out;

        if ($item->has_quantity && $side['quantity'] !== null) {
            $out['quantity'] = (float) $side['quantity'];
        }

        $used = [];

        for ($slot = 1; $slot <= 3; $slot++) {
            $type = $item->{"info_{$slot}_type"};
            if (!$type) continue;

            foreach ($side['subconto'] as $i => $sub) {
                if (isset($used[$i])) continue;

                $infoId = $this->findInfo($type, $sub);
                if (!$infoId) continue;

                $used[$i] = true;
                $out['info'][$slot - 1] = $infoId;
                $out['matched'][] = [
                    'slot' => $slot,
                    'kind' => $sub['kind'],
                    'name' => $sub['name'],
                ];
                break;
            }
        }

        // Субконто, которому не нашлось ни слота, ни элемента справочника.
        // Показываем, но не считаем бедой: в управленческом учёте договоров и
        // документов-регистраторов нет и быть не должно
        foreach ($side['subconto'] as $i => $sub) {
            if (!isset($used[$i])) $out['skipped'][] = $sub['kind'] . ': ' . $sub['name'];
        }

        return $out;
    }

    /**
     * Элемент справочника по субконто.
     *
     * Сначала ИНН, потом наименование: «ООО Ромашка» и «Ромашка, ООО» это одна
     * организация и два разных имени, а ИНН один. Имя сравнивается без учёта
     * регистра, лишних пробелов и разницы «е/ё» — на этом спотыкается любое
     * сравнение справочников, которые вели два разных человека.
     */
    private function findInfo(string $type, array $sub): ?int
    {
        if (!empty($sub['inn'])) {
            $id = $this->byInn[$type][$sub['inn']] ?? null;
            if ($id) return $id;
        }

        return $this->byName[$type][self::normalize($sub['name'])] ?? null;
    }

    /**
     * Состояние проводки у нас: не загружали, загружали и не менялась,
     * загружали и данные разошлись.
     *
     * @return array{0: string, 1: ?int}
     */
    private function compare(array $row): array
    {
        $op = Operation::on($this->conn)
            ->where('source', self::SOURCE)
            ->where('external_id', $row['id'])
            ->first();

        if (!$op) return ['new', null];

        $same = Carbon::parse($op->date)->format('Y-m-d H:i:s') === $row['date']
            && $this->money((float) $op->amount)   === $this->money((float) $row['amount'])
            && (int) $op->in_bi_id                 === $row['debit']['bi_id']
            && (int) $op->out_bi_id                === $row['credit']['bi_id']
            && $this->money((float) $op->in_quantity)  === $this->money($row['debit']['quantity'])
            && $this->money((float) $op->out_quantity) === $this->money($row['credit']['quantity'])
            && (int) $op->project_id               === (int) $this->projectId
            && $this->slots($op, 'in')  === $row['debit']['info']
            && $this->slots($op, 'out') === $row['credit']['info'];

        return [$same ? 'loaded' : 'changed', (int) $op->id];
    }

    private function slots(Operation $op, string $prefix): array
    {
        return array_map(
            fn($slot) => $op->{"{$prefix}_info_{$slot}_id"} ? (int) $op->{"{$prefix}_info_{$slot}_id"} : null,
            [1, 2, 3],
        );
    }

    // ─── Тексты проводки ─────────────────────────────────────────────────────

    private function documentLabel(array $entry): ?string
    {
        $doc = $entry['document'];
        if (!is_array($doc)) return null;

        $parts = array_filter([
            $doc['type']   ?? null,
            isset($doc['number']) ? '№ ' . $doc['number'] : null,
            isset($doc['date'])   ? 'от ' . self::humanDate($doc['date']) : null,
        ]);

        return $parts ? implode(' ', $parts) : null;
    }

    private function documentDate(array $entry): ?string
    {
        $date = is_array($entry['document']) ? ($entry['document']['date'] ?? null) : null;

        return $date ? substr((string) $date, 0, 10) : substr($entry['date'], 0, 10);
    }

    private function content(array $entry): ?string
    {
        $text = $entry['content'] ?: $this->documentLabel($entry);

        return $text ? mb_substr($text, 0, 1000) : null;
    }

    /**
     * В примечании остаётся след: откуда проводка и какая она в 1С.
     * Без этого операцию не с чем сверить, когда бухгалтер спросит.
     */
    private function note(array $entry): string
    {
        $parts = array_filter([
            $this->documentLabel($entry),
            'проводка 1С ' . $entry['id'],
        ]);

        return mb_substr(implode(' · ', $parts), 0, 1000);
    }

    private function label(array $row): string
    {
        return 'Проводка ' . self::humanDate($row['date'])
            . ' на ' . number_format($row['amount'], 2, ',', ' ')
            . ' (' . $row['debit']['account'] . ' / ' . $row['credit']['account'] . ')';
    }

    // ─── Загрузка справочников ───────────────────────────────────────────────

    private function loadMap(): void
    {
        $rows = DB::connection($this->conn)
            ->table('onec_account_map as m')
            ->join('balance_items as b', 'b.id', '=', 'm.bi_id')
            ->whereNull('b.deleted_at')
            ->select('m.account', 'b.*')
            ->get();

        foreach ($rows as $r) {
            $this->map[$r->account] = (int) $r->id;

            // Закрытый ролью счёт в карту не кладём: тогда сторона проводки
            // окажется без счёта и вся строка честно уйдёт в «нельзя взять»
            if (!$this->scope->hides((int) $r->id)) {
                $this->bi[(int) $r->id] = $r;
            }
        }
    }

    /**
     * Справочники читаем только тех типов, которые вообще могут понадобиться —
     * то есть которые стоят в слотах сопоставленных счетов. У номенклатуры
     * бывают десятки тысяч позиций, и тянуть их ради счёта расчётов незачем.
     */
    private function loadInfo(): void
    {
        $types = [];
        foreach ($this->bi as $item) {
            foreach ([1, 2, 3] as $slot) {
                if ($t = $item->{"info_{$slot}_type"}) $types[$t] = true;
            }
        }

        if (!$types) return;

        DB::connection($this->conn)
            ->table('info')
            ->whereIn('type', array_keys($types))
            ->where('is_active', true)
            ->whereNull('deleted_at')
            ->orderBy('id')
            ->select('id', 'type', 'name', 'inn')
            ->chunk(2000, function ($chunk) {
                foreach ($chunk as $info) {
                    $key = self::normalize($info->name);

                    // Первый выигрывает: справочник с двумя «Иванов И.И.» —
                    // беда справочника, а не загрузки, и выбирать за человека
                    // мы не станем
                    $this->byName[$info->type][$key] ??= (int) $info->id;

                    if ($info->inn) $this->byInn[$info->type][$info->inn] ??= (int) $info->id;
                }
            });
    }

    // ─── Мелочи ──────────────────────────────────────────────────────────────

    private function stats(array $rows): array
    {
        $out = ['total' => count($rows), 'amount' => 0.0];

        foreach (['new', 'changed', 'loaded', 'unmapped', 'forbidden', 'locked'] as $s) {
            $out[$s] = 0;
        }

        foreach ($rows as $r) {
            $out[$r['status']]++;
            $out['amount'] += $r['amount'];
        }

        $out['amount'] = round($out['amount'], 2);

        return $out;
    }

    private function locked(string $date): bool
    {
        return $this->lockDate && substr($date, 0, 10) <= $this->lockDate;
    }

    private function warn(string $message): void
    {
        if (count($this->warnings) < self::MAX_WARNINGS) $this->warnings[] = $message;
    }

    /** Сравнение денег через строку: 0.1 + 0.2 !== 0.3 и в PHP тоже. */
    private function money(float $value): string
    {
        return number_format($value, 4, '.', '');
    }

    private static function normalize(string $name): string
    {
        $name = mb_strtolower(trim($name));
        $name = str_replace('ё', 'е', $name);

        return preg_replace('/\s+/u', ' ', $name);
    }

    private static function humanDate(string $date): string
    {
        [$y, $m, $d] = explode('-', substr($date, 0, 10));

        return "{$d}.{$m}.{$y}";
    }
}
