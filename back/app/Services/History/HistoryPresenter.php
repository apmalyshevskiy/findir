<?php

namespace App\Services\History;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * История объекта — для показа.
 *
 * В базе разница хранится сырой: имена полей и значения как есть, включая
 * идентификаторы. Это сознательно — журнал обязан быть записью факта, а не
 * чьей-то трактовки. Человеческие подписи и названия подставляем при чтении:
 * тогда переименованная статья в старой записи покажется нынешним именем, а
 * подписи можно менять, не переписывая историю.
 */
class HistoryPresenter
{
    private const FIELDS = [
        'date'          => 'Дата',
        'project_id'    => 'Проект',
        'amount'        => 'Сумма',
        'amount_vat'    => 'Сумма НДС',
        'quantity'      => 'Количество',
        'in_quantity'   => 'Количество по дебету',
        'out_quantity'  => 'Количество по кредиту',
        'in_bi_id'      => 'Счёт дебета',
        'out_bi_id'     => 'Счёт кредита',
        'bi_id'         => 'Счёт',
        'content'       => 'Содержание',
        'note'          => 'Примечание',
        'is_posted'     => 'Проведена',
        'status'        => 'Состояние',
        'number'        => 'Номер',
        'external_id'   => 'Внешний номер',
        'external_date' => 'Дата документа',
        'external_number' => 'Номер входящего',
        'source'        => 'Источник',
        'deleted_at'    => 'Удаление',
        'items'         => 'Строки',
        // Справочник
        'name'          => 'Наименование',
        'type'          => 'Справочник',
        'code'          => 'Код',
        'inn'           => 'ИНН',
        'parent_id'     => 'Родитель',
        'sort_order'    => 'Порядок',
        'is_active'     => 'Активен',
        'description'   => 'Описание',
        'default_expense_id' => 'Статья расхода по умолчанию',
        'revenue_bi_id' => 'Счёт доходов',
        'cogs_bi_id'    => 'Счёт себестоимости',
        'revenue_item_id' => 'Статья дохода',
    ];

    /**
     * Поля строки документа. Отдельно от полей шапки: там `bi_id` — «Счёт»
     * операции, здесь — счёт этой строки, а «Аналитика 1» строки и «Аналитика 1»
     * шапки соседствуют в одной таблице и их надо различать.
     */
    private const ITEM_FIELDS = [
        'bi_id'          => 'Счёт',
        'info_1_id'      => 'Аналитика 1',
        'info_2_id'      => 'Аналитика 2',
        'info_3_id'      => 'Аналитика 3',
        'head_bi_id'     => 'Счёт шапки',
        'head_info_1_id' => 'Аналитика 1 шапки',
        'head_info_2_id' => 'Аналитика 2 шапки',
        'head_info_3_id' => 'Аналитика 3 шапки',
        'quantity'       => 'Количество',
        'price'          => 'Цена',
        'amount'         => 'Сумма',
        'amount_vat'     => 'НДС',
        'amount_cost'    => 'Себестоимость',
        'note'           => 'Примечание',
    ];

    /**
     * Что в строке не сравниваем.
     *
     * `id` бесполезен: строки при каждом сохранении удаляются и вставляются
     * заново, так что номер меняется даже у нетронутой строки. `content`
     * собирается программой из остальных полей. `sort_order` показываем не
     * строкой сравнения, а сдвигом номера в заголовке.
     */
    private const ITEM_IGNORED = ['id', 'document_id', 'sort_order', 'content', 'created_at', 'updated_at'];

    private const SOURCES = [
        'manual'      => 'вручную',
        'ai'          => 'ИИ-помощник',
        'bulk'        => 'массовая правка',
        'onec'        => 'загрузка 1С',
        'fusionpos'   => 'загрузка FUSIONPOS',
        'bank_import' => 'банковская выписка',
        'document'    => 'документ',
        'auto'        => 'автоматически',
    ];

    private const ACTIONS = [
        'created'  => 'создан',
        'updated'  => 'изменён',
        'deleted'  => 'удалён',
        'restored' => 'восстановлен',
    ];

    public function __construct(private string $conn) {}

    private const ENTITIES = [
        'operation' => 'Операция',
        'document'  => 'Документ',
        'info'      => 'Справочник',
    ];

    /** Версии объекта, новые сверху */
    public function forObject(string $entity, int $id): array
    {
        $rows = DB::connection($this->conn)->table('object_versions')
            ->where('entity', $entity)->where('entity_id', $id)
            ->orderByDesc('version')
            ->get();

        return $this->forRows($rows);
    }

    /**
     * Готовые строки журнала из сырых версий.
     *
     * Одним заходом на всю выборку: имена справочников и счетов по запросу на
     * каждое значение дали бы их сотни.
     *
     * @param array $batchSizes batch => сколько всего правок в этой пачке
     */
    public function forRows($rows, $batchSizes = []): array
    {
        if ($rows->isEmpty()) return [];

        $users = DB::connection($this->conn)->table('users')->pluck('name', 'id');

        [$infoNames, $biNames] = $this->names($rows);

        return $rows->map(function ($r) use ($users, $infoNames, $biNames, $batchSizes) {
            $snapshot = json_decode($r->snapshot, true) ?: [];

            return [
                'entity'        => $r->entity,
                'entity_label'  => self::ENTITIES[$r->entity] ?? $r->entity,
                'entity_id'     => (int) $r->entity_id,
                'title'         => $this->title($r->entity, $snapshot, (int) $r->entity_id, $infoNames, $biNames),
                'version'       => (int) $r->version,
                'action'        => $r->action,
                'action_label'  => self::ACTIONS[$r->action] ?? $r->action,
                'source'        => $r->source,
                'source_label'  => self::SOURCES[$r->source] ?? $r->source,
                'batch'         => $r->batch,
                'batch_size'    => $r->batch ? (int) ($batchSizes[$r->batch] ?? 0) : 0,
                'user_id'       => $r->user_id ? (int) $r->user_id : null,
                'user_name'     => $r->user_id ? ($users[$r->user_id] ?? 'пользователь #' . $r->user_id) : null,
                'restored_from' => $r->restored_from ? (int) $r->restored_from : null,
                // С поясом: приложение живёт в UTC, а читают журнал по местным
                // часам. Без «Z» браузер принимал бы UTC за своё время, и
                // ночная правка показывалась бы вчерашним вечером
                'created_at'    => Carbon::parse($r->created_at, 'UTC')->toIso8601ZuluString(),
                'changes'       => $this->changes($r, $infoNames, $biNames),
            ];
        })->all();
    }

    /**
     * Подпись объекта — из снимка самой версии, а не из нынешнего состояния.
     *
     * Так в журнале виден удалённый объект, и видно, чем он был на тот момент,
     * а не чем стал после следующих правок.
     */
    private function title(string $entity, array $snapshot, int $id, array $infoNames, array $biNames): string
    {
        if ($entity === 'info') {
            return $snapshot['name'] ?? 'элемент #' . $id;
        }

        if ($entity === 'document') {
            $parts = array_filter([
                $snapshot['number'] ? '№ ' . $snapshot['number'] : null,
                isset($snapshot['date']) ? 'от ' . substr((string) $snapshot['date'], 0, 10) : null,
            ]);

            return $parts ? implode(' ', $parts) : 'документ #' . $id;
        }

        // Операция узнаётся по сумме и содержанию: номер мало что говорит
        $parts = array_filter([
            isset($snapshot['amount']) ? number_format((float) $snapshot['amount'], 2, ',', ' ') : null,
            $snapshot['content'] ?? null,
        ]);

        return $parts ? implode(' · ', $parts) : 'операция #' . $id;
    }

    /** Сырые поля версии — понадобятся восстановлению */
    public function snapshot(string $entity, int $id, int $version): ?array
    {
        $row = DB::connection($this->conn)->table('object_versions')
            ->where('entity', $entity)->where('entity_id', $id)->where('version', $version)
            ->first();

        return $row ? json_decode($row->snapshot, true) : null;
    }

    /** @return array{0: array, 1: array} имена элементов справочников и счетов */
    private function names($rows): array
    {
        $infoIds = $biIds = [];

        foreach ($rows as $r) {
            foreach (json_decode($r->diff, true) ?: [] as $c) {
                $field = $c['field'] ?? '';
                foreach ([$c['was'] ?? null, $c['now'] ?? null] as $v) {
                    $this->collectIds($field, $v, $infoIds, $biIds);
                }
            }
        }

        $info = $infoIds
            ? DB::connection($this->conn)->table('info')->whereIn('id', array_keys($infoIds))->pluck('name', 'id')->all()
            : [];

        $bi = $biIds
            ? DB::connection($this->conn)->table('balance_items')->whereIn('id', array_keys($biIds))
                ->get(['id', 'code', 'name'])->mapWithKeys(fn($b) => [$b->id => $b->code . ' ' . $b->name])->all()
            : [];

        return [$info, $bi];
    }

    /**
     * Собрать идентификаторы из значения — в том числе из строк документа.
     *
     * Строки приезжают массивом вложенных записей, и имена внутри них нужны
     * ровно так же, как в шапке: иначе построчная разница покажет «#412 → #87».
     */
    private function collectIds(string $field, $value, array &$infoIds, array &$biIds): void
    {
        if (is_array($value)) {
            foreach ($value as $row) {
                foreach (is_array($row) ? $row : [] as $k => $v) $this->collectIds($k, $v, $infoIds, $biIds);
            }
            return;
        }

        if (!is_numeric($value)) return;

        if (str_contains($field, 'info') || $field === 'default_expense_id' || $field === 'parent_id') {
            $infoIds[(int) $value] = true;
        } elseif (str_contains($field, 'bi_id')) {
            $biIds[(int) $value] = true;
        }
    }

    private function changes($row, array $infoNames, array $biNames): array
    {
        $out = [];

        foreach (json_decode($row->diff, true) ?: [] as $c) {
            $field = $c['field'] ?? '';
            $was   = $c['was'] ?? null;
            $now   = $c['now'] ?? null;

            $change = [
                'field' => $field,
                'label' => self::FIELDS[$field] ?? $field,
                'was'   => $this->value($field, $was, $infoNames, $biNames),
                'now'   => $this->value($field, $now, $infoNames, $biNames),
            ];

            // «2 строки → 3 строки» отвечает только на «сколько». Разбор по
            // строкам отвечает на «какая и что в ней» — считаем его здесь, из
            // тех же снимков, поэтому он виден и у давно записанных версий
            if ($field === 'items' && (is_array($was) || is_array($now))) {
                $change['lines'] = $this->lines(
                    is_array($was) ? $was : [],
                    is_array($now) ? $now : [],
                    $infoNames, $biNames,
                );
            }

            $out[] = $change;
        }

        return $out;
    }

    /**
     * Что стало с каждой строкой документа.
     *
     * Сопоставляем сначала по существу строки — счёт и аналитика, — и только
     * оставшиеся по месту в списке. Наоборот нельзя: удаление первой строки из
     * трёх сдвинуло бы все остальные, и вместо одного «строка удалена» вышло бы
     * три «строка изменена».
     *
     * @return array<int, array>
     */
    private function lines(array $wasRows, array $nowRows, array $infoNames, array $biNames): array
    {
        $was = $this->ordered($wasRows);
        $now = $this->ordered($nowRows);

        $pairs = $usedWas = $usedNow = [];

        foreach ([true, false] as $byKey) {
            foreach ($now as $ni => $n) {
                if (isset($usedNow[$ni])) continue;

                foreach ($was as $wi => $w) {
                    if (isset($usedWas[$wi])) continue;

                    $fits = $byKey
                        ? $this->itemKey($w['row']) === $this->itemKey($n['row'])
                        : $w['n'] === $n['n'];

                    if (!$fits) continue;

                    $usedWas[$wi] = $usedNow[$ni] = true;
                    $pairs[] = [$w, $n];
                    break;
                }
            }
        }

        $out = [];

        foreach ($pairs as [$w, $n]) {
            $changes = $this->itemChanges($w['row'], $n['row'], $infoNames, $biNames);

            if (!$changes && $w['n'] === $n['n']) continue;

            $out[] = [
                'kind'    => $changes ? 'changed' : 'moved',
                'n'       => $n['n'],
                'was_n'   => $w['n'] === $n['n'] ? null : $w['n'],
                'title'   => $this->itemTitle($n['row'], $infoNames, $biNames),
                'summary' => $this->itemSummary($n['row']),
                'changes' => $changes,
            ];
        }

        foreach ($was as $wi => $w) {
            if (isset($usedWas[$wi])) continue;

            $out[] = [
                'kind'    => 'removed',
                'n'       => $w['n'],
                'was_n'   => null,
                'title'   => $this->itemTitle($w['row'], $infoNames, $biNames),
                'summary' => $this->itemSummary($w['row']),
                'changes' => [],
            ];
        }

        foreach ($now as $ni => $n) {
            if (isset($usedNow[$ni])) continue;

            $out[] = [
                'kind'    => 'added',
                'n'       => $n['n'],
                'was_n'   => null,
                'title'   => $this->itemTitle($n['row'], $infoNames, $biNames),
                'summary' => $this->itemSummary($n['row']),
                'changes' => [],
            ];
        }

        // Переезд строки стоит показывать, только если её никто не толкал:
        // после удаления первой строки все нижние сдвигаются сами, и говорить
        // о каждой «перемещена» — прятать за шумом единственное настоящее
        // событие. Перестановку же строк местами иначе не увидеть совсем
        $shifted = (bool) array_filter($out, fn($l) => in_array($l['kind'], ['added', 'removed'], true));

        if ($shifted) $out = array_filter($out, fn($l) => $l['kind'] !== 'moved');

        $out = array_values($out);

        usort($out, fn($a, $b) => [$a['n'], $a['kind']] <=> [$b['n'], $b['kind']]);

        return $out;
    }

    /** Строки по порядку, с номером, каким его видит человек в документе */
    private function ordered(array $rows): array
    {
        $rows = array_values(array_filter($rows, 'is_array'));

        usort($rows, fn($a, $b) => ($a['sort_order'] ?? 0) <=> ($b['sort_order'] ?? 0));

        return array_map(fn($row, $i) => ['n' => $i + 1, 'row' => $row], $rows, array_keys($rows));
    }

    /** Существо строки: что и куда. Суммы и количество — уже её содержимое */
    private function itemKey(array $row): string
    {
        return implode('|', array_map(
            fn($f) => (string) ($row[$f] ?? ''),
            ['bi_id', 'info_1_id', 'info_2_id', 'info_3_id'],
        ));
    }

    private function itemTitle(array $row, array $infoNames, array $biNames): string
    {
        foreach (['info_1_id', 'info_2_id', 'info_3_id'] as $f) {
            if (!empty($row[$f]) && isset($infoNames[(int) $row[$f]])) return $infoNames[(int) $row[$f]];
        }

        if (!empty($row['bi_id'])) return $biNames[(int) $row['bi_id']] ?? '#' . $row['bi_id'];

        return 'строка';
    }

    /** Короткая сводка добавленной или удалённой строки: «2 × 199,50 = 399,00» */
    private function itemSummary(array $row): string
    {
        $qty    = (float) ($row['quantity'] ?? 0);
        $price  = (float) ($row['price'] ?? 0);
        $amount = number_format((float) ($row['amount'] ?? 0), 2, ',', ' ');

        if ($qty <= 0 || $price <= 0) return $amount;

        return rtrim(rtrim(number_format($qty, 3, ',', ' '), '0'), ',')
            . ' × ' . number_format($price, 2, ',', ' ') . ' = ' . $amount;
    }

    /** @return array<int, array> различия двух версий одной строки */
    private function itemChanges(array $was, array $now, array $infoNames, array $biNames): array
    {
        $out = [];

        foreach (array_keys($was + $now) as $field) {
            if (in_array($field, self::ITEM_IGNORED, true)) continue;

            $a = $was[$field] ?? null;
            $b = $now[$field] ?? null;

            // Через число: база отдаёт «100.00», форма — 100, и без приведения
            // журнал показывал бы изменение там, где его нет
            $same = is_numeric($a) && is_numeric($b)
                ? (float) $a === (float) $b
                : (string) $a === (string) $b;

            if ($same) continue;

            $out[] = [
                'field' => $field,
                'label' => self::ITEM_FIELDS[$field] ?? self::FIELDS[$field] ?? $field,
                'was'   => $this->value($field, $a, $infoNames, $biNames),
                'now'   => $this->value($field, $b, $infoNames, $biNames),
            ];
        }

        return $out;
    }

    /** Значение словами: id — именем, флаг — «да/нет», пусто — прочерком */
    private function value(string $field, $value, array $infoNames, array $biNames): string
    {
        if ($value === null || $value === '') return '—';

        // Строки документа: в разницу они попадают целиком, и печатать их
        // массивом бессмысленно — говорим, сколько их стало
        if (is_array($value)) return count($value) . ' ' . $this->plural(count($value), 'строка', 'строки', 'строк');

        if (in_array($field, ['is_posted', 'is_active'], true)) return $value ? 'да' : 'нет';

        if (is_numeric($value)) {
            if (str_contains($field, 'bi_id')) return $biNames[(int) $value] ?? '#' . $value;

            if (str_contains($field, 'info') || $field === 'default_expense_id' || $field === 'parent_id') {
                return $infoNames[(int) $value] ?? '#' . $value;
            }

            // Количество хранится с тремя знаками, но «2,000 шт» читается хуже,
            // чем «2»: лишние нули убираем, значащие оставляем
            if (in_array($field, ['quantity', 'in_quantity', 'out_quantity'], true)) {
                return rtrim(rtrim(number_format((float) $value, 3, ',', ' '), '0'), ',');
            }

            if (in_array($field, ['amount', 'amount_vat', 'amount_cost', 'price'], true)) {
                return number_format((float) $value, 2, ',', ' ');
            }
        }

        return (string) $value;
    }

    private function plural(int $n, string $one, string $few, string $many): string
    {
        $mod100 = $n % 100;
        if ($mod100 >= 11 && $mod100 <= 14) return $many;

        return match ($n % 10) {
            1       => $one,
            2, 3, 4 => $few,
            default => $many,
        };
    }
}
