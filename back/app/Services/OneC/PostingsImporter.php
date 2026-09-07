<?php

namespace App\Services\OneC;

use App\Models\Tenant\Integration;
use App\Models\Tenant\Operation;
use App\Services\AccountScope;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Проводки 1С → операции FINDIR.
 *
 * Одна проводка становится одной операцией: дебет ложится в in_*, кредит в
 * out_*. Модель у нас та же двусторонняя, поэтому разбирать проводку не нужно —
 * нужно только перевести счета и аналитику на наши справочники.
 *
 * Соответствия лежат в `integration_links` под своей интеграцией: строки
 * `entity = account` переводят счета, `entity = subconto` — аналитику.
 * `local_id = NULL` в такой строке означает «не переносить»: это решение
 * человека, и оно отличается от «строки нет» — при отсутствии строки работает
 * поиск по наименованию.
 *
 * Порядок поиска аналитики: **привязка → ИНН → наименование**. Решение человека
 * важнее совпадения строк, поэтому привязка смотрится первой и, если она есть,
 * поиск на ней и заканчивается.
 *
 * Что не делается автоматически: элементы справочников не заводятся. В типовой
 * проводке 1С субконто больше, чем нужно управленческому учёту — договоры,
 * ставки НДС, документы-регистраторы в качестве субконто. Заводи мы их сами,
 * справочник зарос бы за первую загрузку. Не нашлось — слот пуст, но проводка
 * грузится: сумма важнее аналитики.
 */
final class PostingsImporter
{
    /** Метка источника в операциях: по ней же ищутся ранее загруженные. */
    public const SOURCE = 'onec';

    /** Виды строк соответствия в integration_links. */
    public const ENTITY_ACCOUNT  = 'account';
    public const ENTITY_SUBCONTO = 'subconto';

    /** Сколько предупреждений возвращаем: дальше это шум, а не помощь. */
    private const MAX_WARNINGS = 50;

    /** Длина external_id в integration_links. */
    public const KEY_LIMIT = 191;

    private ?int $projectId;

    /** счёт 1С → bi_id */
    private array $accounts = [];

    /** счёт 1С, помеченный «не переносить» */
    private array $accountsSkipped = [];

    /** bi_id → строка плана счетов */
    private array $bi = [];

    /** ключ субконто → info_id (null означает «не переносить») */
    private array $bind = [];

    /** тип аналитики → [нормализованное имя => id] */
    private array $byName = [];

    /** тип аналитики → [ИНН => id] */
    private array $byInn = [];

    /** id → элемент справочника (name, type) */
    private array $infoById = [];

    private array $warnings = [];

    public function __construct(
        private string $conn,
        private AccountScope $scope,
        private Integration $integration,
        private ?string $lockDate = null,
    ) {
        $this->projectId = ((int) $this->integration->setting('project_id')) ?: null;

        $this->loadAccounts();
        $this->loadBindings();
        $this->loadInfo();
    }

    // ─── Ключи соответствия ──────────────────────────────────────────────────

    /**
     * Ключ субконто: вид плюс нормализованное наименование.
     *
     * Не код: код есть не у всякого субконто, а у одноимённых элементов разных
     * видов совпадает. Вид в ключе обязателен — «Основной склад» среди складов
     * и среди подразделений это разные вещи.
     */
    public static function subcontoKey(string $kind, string $name): string
    {
        return mb_substr(mb_strtolower(trim($kind)) . '|' . self::normalize($name), 0, self::KEY_LIMIT);
    }

    public static function normalize(string $name): string
    {
        $name = mb_strtolower(trim($name));
        $name = str_replace('ё', 'е', $name);

        return preg_replace('/\s+/u', ' ', $name);
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
            $biId = $this->accounts[$code] ?? null;
            $item = $biId ? ($this->bi[$biId] ?? null) : null;

            $a['bi_id']   = $item ? (int) $biId : null;
            $a['bi']      = $item ? $item->code . ' ' . $item->name : null;
            $a['skipped'] = isset($this->accountsSkipped[$code]);
            $a['hidden']  = $biId !== null && $item === null;   // сопоставлен, но закрыт ролью
        }
        unset($a);

        return [
            'rows'     => $rows,
            'accounts' => array_values($accounts),
            'subconto' => $this->subconto($file),
            'stats'    => $this->stats($rows),
        ];
    }

    /**
     * Уникальные субконто файла: что это, сколько раз встретилось и во что
     * превращается сейчас.
     *
     * Разбирать аналитику по каждой строке проводок бессмысленно: одно и то же
     * субконто встречается в сорока проводках, и правится оно один раз. Поэтому
     * отдельный список — как у счетов.
     */
    public function subconto(array $file): array
    {
        $found = [];

        foreach ($file['entries'] as $entry) {
            foreach (['debit', 'credit'] as $side) {
                $account = $entry[$side]['account'];
                $types   = $this->slotTypes($account);
                $mapped  = $this->accountMapped($account);

                foreach ($entry[$side]['subconto'] as $sub) {
                    $key = self::subcontoKey($sub['kind'], $sub['name']);

                    $found[$key] ??= [
                        'key'      => $key,
                        'kind'     => $sub['kind'],
                        'name'     => $sub['name'],
                        'code'     => $sub['code'],
                        'inn'      => $sub['inn'],
                        'count'    => 0,
                        'types'    => [],
                        'accounts' => [],
                        'mapped'   => false,
                    ];

                    $found[$key]['count']++;
                    $found[$key]['mapped'] = $found[$key]['mapped'] || $mapped;
                    $found[$key]['types'] = array_values(array_unique(
                        array_merge($found[$key]['types'], $types)
                    ));
                    $found[$key]['accounts'] = array_values(array_unique(
                        array_merge($found[$key]['accounts'], [$account])
                    ));
                }
            }
        }

        foreach ($found as &$sub) {
            $res = $this->resolveSub($sub, $sub['types']);

            $sub['info_id']   = $res['info_id'];
            $sub['info_name'] = $res['info_name'];
            // Вид уже подобранного элемента: окно привязки открывается сразу на
            // нём, иначе человек ищет заново то, что и так найдено
            $sub['info_type'] = $res['type'];
            $sub['source']    = $res['source'];
            $sub['bound']     = $res['source'] === 'binding';

            // Пока счёт не сопоставлен, про аналитику говорить рано: слотов
            // нет не потому, что их нет у счёта, а потому что счёта нет
            $sub['reason'] = !$sub['mapped'] && $res['source'] === null
                ? 'счёт 1С не сопоставлен'
                : $res['reason'];
        }
        unset($sub);

        // Сначала непривязанное и ненайденное — с ним и надо разбираться,
        // а найденное по имени просто подтверждается взглядом
        $order = ['none' => 0, 'binding' => 3, 'inn' => 2, 'name' => 2];
        uasort($found, function ($a, $b) use ($order) {
            $wa = $order[$a['source'] ?? 'none'] ?? 1;
            $wb = $order[$b['source'] ?? 'none'] ?? 1;

            return $wa <=> $wb ?: $b['count'] <=> $a['count'];
        });

        return array_values($found);
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
        $counts = ['fetched' => 0, 'created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0];

        if (!$this->projectId) {
            return $counts + ['warnings' => ['Не выбран проект — операции некуда складывать']];
        }

        foreach ($file['entries'] as $entry) {
            $row = $this->build($entry);

            if ($pick !== null && !isset($pick[$row['id']])) continue;

            $counts['fetched']++;

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
            $row['status']  = $debit['hidden'] || $credit['hidden'] ? 'forbidden' : 'unmapped';
            $row['problem'] = $row['status'] === 'forbidden'
                ? 'счёт закрыт для вашей должности'
                : $this->unmappedProblem($debit, $credit);

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

    /**
     * «Не сопоставлен» и «решено не переносить» — разные вещи, и человеку важно
     * знать какая: первое чинится, второе он выбрал сам.
     */
    private function unmappedProblem(array $debit, array $credit): string
    {
        $notSet  = [];
        $skipped = [];

        foreach ([$debit, $credit] as $side) {
            if ($side['bi_id'] !== null) continue;
            if ($side['skipped']) $skipped[] = $side['account'];
            else                  $notSet[]  = $side['account'];
        }

        $parts = [];
        if ($notSet)  $parts[] = 'счёт 1С не сопоставлен: ' . implode(', ', array_unique($notSet));
        if ($skipped) $parts[] = 'счёт отмечен «не переносить»: ' . implode(', ', array_unique($skipped));

        return implode('; ', $parts);
    }

    /** Одна сторона проводки: счёт, количество и аналитика по слотам. */
    private function side(array $side): array
    {
        $code = $side['account'];
        $biId = $this->accounts[$code] ?? null;
        $item = $biId ? ($this->bi[$biId] ?? null) : null;

        $out = [
            'account'   => $code,
            'bi_id'     => $item ? (int) $biId : null,
            'bi'        => $item ? $item->code . ' ' . $item->name : null,
            // Счёт сопоставлен, но закрыт ролью: это не «забыли настроить»
            'hidden'    => $biId !== null && $item === null,
            'skipped'   => isset($this->accountsSkipped[$code]),
            'info'      => [null, null, null],
            'analytics' => [],
            'quantity'  => 0.0,
        ];

        if ($item && $item->has_quantity && $side['quantity'] !== null) {
            $out['quantity'] = (float) $side['quantity'];
        }

        $types = $item ? $this->slotTypes($code) : [];

        // Аналитику перечисляем всегда, даже когда счёт не сопоставлен: человек
        // должен видеть состав проводки целиком, а не половину
        foreach ($side['subconto'] as $sub) {
            $res = $item
                ? $this->resolveSub($sub, $types)
                : ['info_id' => null, 'info_name' => null, 'type' => null, 'source' => null,
                   'reason' => 'счёт не сопоставлен'];

            $out['analytics'][] = [
                'key'       => self::subcontoKey($sub['kind'], $sub['name']),
                'kind'      => $sub['kind'],
                'name'      => $sub['name'],
                'slot'      => null,
                'info_id'   => $res['info_id'],
                'info_name' => $res['info_name'],
                'source'    => $res['source'],
                'reason'    => $res['reason'],
                'type'      => $res['type'],
            ];
        }

        if (!$item) return $out;

        // Раскладка по слотам: слот ждёт свой тип, и берём первое подходящее
        // из ещё не разложенного
        for ($slot = 1; $slot <= 3; $slot++) {
            $type = $item->{"info_{$slot}_type"};
            if (!$type) continue;

            foreach ($out['analytics'] as $i => $a) {
                if ($a['slot'] !== null || $a['info_id'] === null || $a['type'] !== $type) continue;

                $out['analytics'][$i]['slot'] = $slot;
                $out['info'][$slot - 1] = $a['info_id'];
                break;
            }
        }

        // Разрешилось, но места не нашлось — про это надо сказать, иначе
        // выглядит как потерянная аналитика
        foreach ($out['analytics'] as $i => $a) {
            if ($a['slot'] === null && $a['info_id'] !== null && !$a['reason']) {
                $out['analytics'][$i]['reason'] = 'у счёта нет свободного слота под этот тип';
            }
        }

        return $out;
    }

    /**
     * Элемент справочника для субконто.
     *
     * Привязка первой и окончательно: если человек сказал «это вот тот
     * элемент» или «не переносить», искать дальше нечего. Дальше ИНН — «ООО
     * Ромашка» и «Ромашка, ООО» это одна организация и два разных имени, а ИНН
     * один. И только потом наименование.
     *
     * @param array $types типы слотов счёта — искать имеет смысл только среди них
     */
    private function resolveSub(array $sub, array $types): array
    {
        $none = ['info_id' => null, 'info_name' => null, 'type' => null, 'source' => null, 'reason' => null];

        $key = self::subcontoKey($sub['kind'], $sub['name']);

        if (array_key_exists($key, $this->bind)) {
            $id = $this->bind[$key];

            if ($id === null) {
                return array_merge($none, ['source' => 'binding', 'reason' => 'привязано к «не переносить»']);
            }

            $info = $this->infoById[$id] ?? null;
            if (!$info) {
                return array_merge($none, ['source' => 'binding', 'reason' => 'привязанный элемент справочника удалён']);
            }

            return [
                'info_id'   => $id,
                'info_name' => $info->name,
                'type'      => $info->type,
                'source'    => 'binding',
                'reason'    => null,
            ];
        }

        if (!$types) {
            return array_merge($none, ['reason' => 'у счёта нет слотов аналитики']);
        }

        if (!empty($sub['inn'])) {
            foreach ($types as $type) {
                $id = $this->byInn[$type][$sub['inn']] ?? null;
                if ($id) return $this->hit($id, $type, 'inn');
            }
        }

        $nameKey = self::normalize($sub['name']);
        foreach ($types as $type) {
            $id = $this->byName[$type][$nameKey] ?? null;
            if ($id) return $this->hit($id, $type, 'name');
        }

        return array_merge($none, ['reason' => 'нет такой аналитики в справочниках']);
    }

    private function hit(int $id, string $type, string $source): array
    {
        return [
            'info_id'   => $id,
            'info_name' => $this->infoById[$id]->name ?? null,
            'type'      => $type,
            'source'    => $source,
            'reason'    => null,
        ];
    }

    /** Сопоставлен ли счёт и виден ли он этой должности. */
    private function accountMapped(string $account): bool
    {
        $biId = $this->accounts[$account] ?? null;

        return $biId !== null && isset($this->bi[$biId]);
    }

    /** Типы слотов сопоставленного счёта, по порядку слотов и без повторов. */
    private function slotTypes(string $account): array
    {
        $biId = $this->accounts[$account] ?? null;
        $item = $biId ? ($this->bi[$biId] ?? null) : null;
        if (!$item) return [];

        $types = [];
        foreach ([1, 2, 3] as $slot) {
            if ($t = $item->{"info_{$slot}_type"}) $types[$t] = true;
        }

        return array_keys($types);
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
            && $this->money((float) $op->amount)       === $this->money((float) $row['amount'])
            && (int) $op->in_bi_id                     === $row['debit']['bi_id']
            && (int) $op->out_bi_id                    === $row['credit']['bi_id']
            && $this->money((float) $op->in_quantity)  === $this->money($row['debit']['quantity'])
            && $this->money((float) $op->out_quantity) === $this->money($row['credit']['quantity'])
            && (int) $op->project_id                   === (int) $this->projectId
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

    // ─── Загрузка соответствий и справочников ────────────────────────────────

    private function loadAccounts(): void
    {
        $rows = DB::connection($this->conn)
            ->table('integration_links as l')
            ->leftJoin('balance_items as b', function ($join) {
                $join->on('b.id', '=', 'l.local_id')->whereNull('b.deleted_at');
            })
            ->where('l.integration_id', $this->integration->id)
            ->where('l.entity', self::ENTITY_ACCOUNT)
            ->select('l.external_id as account', 'l.local_id', 'b.*')
            ->get();

        foreach ($rows as $row) {
            // Строка без цели — «не переносить». Отличается от отсутствия
            // строки: там счёт просто ещё не разбирали
            if ($row->local_id === null) {
                $this->accountsSkipped[$row->account] = true;
                continue;
            }

            // Счёт удалён из плана счетов — привязка повисла, ведём себя как
            // при отсутствии привязки
            if ($row->id === null) continue;

            $this->accounts[$row->account] = (int) $row->local_id;

            // Закрытый ролью счёт в карту не кладём: сторона проводки окажется
            // без счёта, и строка честно уйдёт в «нельзя взять»
            if (!$this->scope->hides((int) $row->local_id)) {
                $this->bi[(int) $row->local_id] = $row;
            }
        }
    }

    private function loadBindings(): void
    {
        $rows = DB::connection($this->conn)
            ->table('integration_links')
            ->where('integration_id', $this->integration->id)
            ->where('entity', self::ENTITY_SUBCONTO)
            ->select('external_id', 'local_id')
            ->get();

        foreach ($rows as $row) {
            $this->bind[$row->external_id] = $row->local_id === null ? null : (int) $row->local_id;
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

        if ($types) {
            DB::connection($this->conn)
                ->table('info')
                ->whereIn('type', array_keys($types))
                ->where('is_active', true)
                ->whereNull('deleted_at')
                ->orderBy('id')
                ->select('id', 'type', 'name', 'inn')
                ->chunk(2000, function ($chunk) {
                    foreach ($chunk as $info) {
                        $id  = (int) $info->id;
                        $key = self::normalize($info->name);

                        // Первый выигрывает: справочник с двумя «Иванов И.И.» —
                        // беда справочника, а не загрузки, и выбирать за
                        // человека мы не станем
                        $this->byName[$info->type][$key] ??= $id;
                        if ($info->inn) $this->byInn[$info->type][$info->inn] ??= $id;

                        $this->infoById[$id] = $info;
                    }
                });
        }

        // Привязка могла указывать на элемент типа, который мы не читали:
        // человек вправе привязать что угодно, а показать название надо
        $bound   = array_filter(array_values($this->bind), fn($id) => $id !== null);
        $missing = array_diff($bound, array_keys($this->infoById));

        if ($missing) {
            $extra = DB::connection($this->conn)->table('info')
                ->whereIn('id', $missing)->whereNull('deleted_at')
                ->select('id', 'type', 'name', 'inn')->get();

            foreach ($extra as $info) $this->infoById[(int) $info->id] = $info;
        }
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

    private static function humanDate(string $date): string
    {
        [$y, $m, $d] = explode('-', substr($date, 0, 10));

        return "{$d}.{$m}.{$y}";
    }
}
