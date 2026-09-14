<?php

namespace App\Services\History;

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

    private const SOURCES = [
        'manual'      => 'вручную',
        'ai'          => 'ИИ-помощник',
        'bulk'        => 'массовая правка',
        'onec'        => 'загрузка 1С',
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
                'created_at'    => $r->created_at,
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
                    if (!is_numeric($v)) continue;

                    if (str_contains($field, 'info') || $field === 'default_expense_id' || $field === 'parent_id') {
                        $infoIds[(int) $v] = true;
                    } elseif (str_contains($field, 'bi_id')) {
                        $biIds[(int) $v] = true;
                    }
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

    private function changes($row, array $infoNames, array $biNames): array
    {
        $out = [];

        foreach (json_decode($row->diff, true) ?: [] as $c) {
            $field = $c['field'] ?? '';

            $out[] = [
                'field' => $field,
                'label' => self::FIELDS[$field] ?? $field,
                'was'   => $this->value($field, $c['was'] ?? null, $infoNames, $biNames),
                'now'   => $this->value($field, $c['now'] ?? null, $infoNames, $biNames),
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

            if (in_array($field, ['amount', 'amount_vat', 'quantity', 'in_quantity', 'out_quantity'], true)) {
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
