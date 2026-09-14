<?php

namespace App\Services\History;

use App\Models\Tenant\Document;
use App\Models\Tenant\DocumentItem;
use App\Models\Tenant\Info;
use App\Models\Tenant\Operation;
use App\Services\AccountScope;
use App\Services\Documents\DocumentService;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Возврат объекта к прежней версии.
 *
 * Записывается снимок версии, а не разворачивается цепочка разностей: одна
 * битая ссылка в середине ломала бы всё, что позади.
 *
 * Главное здесь — проверки. Вернуть прошлое состояние можно только туда, куда
 * его сегодня вообще позволено записать: закрытый период, закрытые должностью
 * счета и удалённые элементы справочников — всё это отказ, а не молчаливая
 * запись. Иначе история стала бы обходным путём мимо правил учёта.
 *
 * Само восстановление — обычная правка: оно пишется новой версией со своим
 * автором и пометкой, из какой версии пришло. Историю не переписываем никогда.
 */
final class HistoryRestorer
{
    /** Поля операции, ссылающиеся на справочник и на счета */
    private const OP_INFO_FIELDS = [
        'in_info_1_id', 'in_info_2_id', 'in_info_3_id',
        'out_info_1_id', 'out_info_2_id', 'out_info_3_id',
    ];
    private const OP_BI_FIELDS = ['in_bi_id', 'out_bi_id'];

    public function __construct(
        private string $conn,
        private AccountScope $scope,
        private ?string $lockDate = null,
    ) {}

    /**
     * @return array{ok: bool, message: string, problems?: array<int, string>}
     */
    public function restore(string $entity, int $id, int $version): array
    {
        $snapshot = (new HistoryPresenter($this->conn))->snapshot($entity, $id, $version);
        if (!$snapshot) return $this->fail('Такой версии нет');

        return match ($entity) {
            'operation' => $this->restoreOperation($id, $version, $snapshot),
            'info'      => $this->restoreInfo($id, $version, $snapshot),
            'document'  => $this->restoreDocument($id, $version, $snapshot),
            default     => $this->fail('Для этого вида объектов возврат версии пока не сделан'),
        };
    }

    // ─── Операция ────────────────────────────────────────────────────────────

    private function restoreOperation(int $id, int $version, array $snapshot): array
    {
        $op = Operation::on($this->conn)->withTrashed()->find($id);
        if (!$op) return $this->fail('Операция не найдена');

        // Операция из документа правится только через документ — и возврат
        // версии здесь был бы обходным путём: следующее проведение всё равно
        // перезапишет её заново
        if ($op->table_name === 'documents' && $op->table_id) {
            return $this->fail('Операция создана документом. Возвращайте версию документа, а не операции');
        }

        $problems = [];

        // Закрытый период по обеим датам: и там, где операция стоит сейчас, и
        // там, куда её вернёт версия
        foreach ([['нынешняя дата', $op->date], ['дата в версии', $snapshot['date'] ?? null]] as [$what, $date]) {
            if ($date && $this->locked($date)) {
                $problems[] = ucfirst($what) . ' — ' . $this->dateText($date) . ' — в закрытом периоде (по ' . $this->lockDate . ')';
            }
        }

        // Закрытые должностью счета — тоже с обеих сторон
        $accounts = array_filter([
            $op->in_bi_id, $op->out_bi_id,
            $snapshot['in_bi_id'] ?? null, $snapshot['out_bi_id'] ?? null,
        ]);

        if ($this->scope->hidesAny(array_values($accounts))) {
            $problems[] = 'В операции или в версии есть счёт, закрытый для вашей должности';
        }

        $problems = array_merge(
            $problems,
            $this->missingRefs($snapshot, self::OP_INFO_FIELDS, 'info', 'Аналитика'),
            $this->missingRefs($snapshot, self::OP_BI_FIELDS, 'balance_items', 'Счёт'),
        );

        if ($problems) return $this->fail('Вернуть эту версию нельзя', $problems);

        return $this->write($op, $snapshot, $version, 'Операция возвращена к версии ' . $version);
    }

    // ─── Элемент справочника ─────────────────────────────────────────────────

    private function restoreInfo(int $id, int $version, array $snapshot): array
    {
        $item = Info::on($this->conn)->withTrashed()->find($id);
        if (!$item) return $this->fail('Элемент справочника не найден');

        $problems = $this->missingRefs($snapshot, ['parent_id', 'default_expense_id'], 'info', 'Ссылка');

        // Смена вида справочника задним числом: элемент уже лежит в слотах
        // счетов, объявленных под нынешний вид, и после возврата эти суммы
        // оказались бы в разрезе, который их не принимает
        $wasType = $snapshot['type'] ?? null;
        if ($wasType && $wasType !== $item->type) {
            $used = $this->usedInOperations($id);

            if ($used > 0) {
                $problems[] = "В версии это «{$wasType}», сейчас «{$item->type}», "
                    . "а на элемент уже ссылаются операции ($used). Смена вида сломала бы их разрезы";
            }
        }

        if ($problems) return $this->fail('Вернуть эту версию нельзя', $problems);

        $wasDeleted = $item->trashed();

        return $this->write($item, $snapshot, $version, $wasDeleted
            ? 'Элемент восстановлен из версии ' . $version
            : 'Элемент возвращён к версии ' . $version);
    }

    // ─── Документ ────────────────────────────────────────────────────────────

    /** Поля шапки и строк, ссылающиеся на справочник и на счета */
    private const DOC_INFO_FIELDS  = ['info_1_id', 'info_2_id', 'info_3_id', 'revenue_item_id'];
    private const DOC_BI_FIELDS    = ['bi_id', 'revenue_bi_id', 'cogs_bi_id'];
    private const ITEM_INFO_FIELDS = ['info_1_id', 'info_2_id', 'info_3_id',
                                      'head_info_1_id', 'head_info_2_id', 'head_info_3_id'];
    private const ITEM_BI_FIELDS   = ['bi_id', 'head_bi_id'];

    /**
     * Документ возвращается целиком: шапка, строки и состояние проведения.
     *
     * Строки — часть документа, а не отдельные объекты: вернуть шапку без них
     * значит получить документ, не сходящийся с собственной суммой. Поэтому
     * строки заменяются полностью снимком, а не сверяются построчно.
     *
     * Состояние проведения тоже часть версии. Был проведён — после возврата
     * перепроводим, и операции рождаются заново из восстановленных строк. Тут
     * нечего терять: операции документа руками не правятся ни поштучно, ни
     * массовой правкой — их значения и так пересчитывает каждое проведение.
     */
    private function restoreDocument(int $id, int $version, array $snapshot): array
    {
        $doc = Document::on($this->conn)->withTrashed()->with('items')->find($id);
        if (!$doc) return $this->fail('Документ не найден');

        $items    = $snapshot['items'] ?? [];
        $problems = [];

        // Закрытый период по обеим датам: проведение создаёт операции в
        // периоде документа, отмена — удаляет, и то и другое там запрещено
        foreach ([['нынешняя дата', $doc->date], ['дата в версии', $snapshot['date'] ?? null]] as [$what, $date]) {
            if ($date && $this->locked($date)) {
                $problems[] = ucfirst($what) . ' — ' . $this->dateText($date)
                    . ' — в закрытом периоде (по ' . $this->lockDate . ')';
            }
        }

        $accounts = array_filter(array_merge(
            [$doc->bi_id, $snapshot['bi_id'] ?? null],
            $doc->items->pluck('bi_id')->all(),
            array_column($items, 'bi_id'),
        ));

        if ($this->scope->hidesAny(array_values($accounts))) {
            $problems[] = 'В документе или в версии есть счёт, закрытый для вашей должности';
        }

        $problems = array_merge(
            $problems,
            $this->missingRefs($snapshot, self::DOC_INFO_FIELDS, 'info', 'Аналитика'),
            $this->missingRefs($snapshot, self::DOC_BI_FIELDS, 'balance_items', 'Счёт'),
        );

        foreach ($items as $n => $item) {
            $where = ' (строка ' . ($n + 1) . ')';

            foreach ($this->missingRefs($item, self::ITEM_INFO_FIELDS, 'info', 'Аналитика') as $p) {
                $problems[] = $p . $where;
            }
            foreach ($this->missingRefs($item, self::ITEM_BI_FIELDS, 'balance_items', 'Счёт') as $p) {
                $problems[] = $p . $where;
            }
        }

        if ($problems) return $this->fail('Вернуть эту версию нельзя', array_values(array_unique($problems)));

        return $this->writeDocument($doc, $snapshot, $items, $version);
    }

    private function writeDocument(Document $doc, array $snapshot, array $items, int $version): array
    {
        $history = app(History::class);
        $before  = $doc->historySnapshot();

        $wantPosted = ($snapshot['status'] ?? 'draft') === 'posted';
        $wasDeleted = $doc->trashed();

        DB::connection($this->conn)->transaction(function () use ($doc, $snapshot, $items, $wantPosted, $history) {
            $history->silently(function () use ($doc, $snapshot, $items, $wantPosted) {
                // Проведённый документ сначала распроводим: иначе его операции
                // остались бы от прежних строк
                if ($doc->isPosted()) DocumentService::cancel($doc);

                $fields = array_intersect_key($snapshot, array_flip($doc->getFillable()));
                unset($fields['status']);   // состоянием распоряжается проведение

                $doc->forceFill($fields);
                if ($doc->trashed()) $doc->deleted_at = null;
                $doc->status = 'draft';
                $doc->save();

                DB::connection($doc->getConnectionName())
                    ->table('document_items')->where('document_id', $doc->id)->delete();

                foreach ($items as $i => $row) {
                    $item = (new DocumentItem)->setConnection($doc->getConnectionName());
                    $item->forceFill(array_intersect_key($row, array_flip($item->getFillable())) + [
                        'document_id' => $doc->id,
                        'sort_order'  => $row['sort_order'] ?? $i,
                    ])->save();
                }

                if ($wantPosted) DocumentService::post($doc->load('items'));
            });
        });

        $history->recordFrom($doc->refresh(), $before, 'restored', $version);

        return ['ok' => true, 'message' => $wasDeleted
            ? 'Документ восстановлен из версии ' . $version . ($wantPosted ? ' и проведён' : '')
            : 'Документ возвращён к версии ' . $version . ($wantPosted ? ' и перепроведён' : '')];
    }

    // ─── Общее ───────────────────────────────────────────────────────────────

    /**
     * Записать снимок.
     *
     * Возвращаем только заполняемые поля: id, даты создания и служебные связи
     * с документом принадлежат объекту, а не его версии. Удалённый объект
     * оживает: если человек возвращает версию, он хочет объект обратно.
     */
    private function write(Model $model, array $snapshot, int $version, string $message): array
    {
        $fields = array_intersect_key($snapshot, array_flip($model->getFillable()));

        $history = app(History::class);
        $before  = $model->historySnapshot();

        DB::connection($this->conn)->transaction(function () use ($model, $fields, $history) {
            $history->silently(function () use ($model, $fields) {
                $model->forceFill($fields);
                if (method_exists($model, 'trashed') && $model->trashed()) $model->deleted_at = null;

                $model->save();
            });
        });

        // Восстановление — это новое изменение, а не перемотка: у него свой
        // автор, своё время и пометка, откуда оно пришло
        $history->recordFrom($model->refresh(), $before, 'restored', $version);

        return ['ok' => true, 'message' => $message];
    }

    /** Ссылки на удалённые элементы: вернуть версию с ними — оставить сумму без имени */
    private function missingRefs(array $snapshot, array $fields, string $table, string $label): array
    {
        $ids = [];
        foreach ($fields as $f) {
            $v = $snapshot[$f] ?? null;
            if ($v) $ids[(int) $v] = true;
        }

        if (!$ids) return [];

        $alive = DB::connection($this->conn)->table($table)
            ->whereIn('id', array_keys($ids))->whereNull('deleted_at')->pluck('id')->all();

        $missing = array_diff(array_keys($ids), $alive);
        if (!$missing) return [];

        // Название берём вместе с удалёнными: «удалён КОМУС» понятнее, чем «#12»
        $names = DB::connection($this->conn)->table($table)
            ->whereIn('id', $missing)->pluck('name', 'id')->all();

        return array_map(
            fn($mid) => "$label «" . ($names[$mid] ?? "#$mid") . "» удалён — сначала восстановите его",
            array_values($missing),
        );
    }

    private function usedInOperations(int $infoId): int
    {
        $q = DB::connection($this->conn)->table('operations')->whereNull('deleted_at');

        return $q->where(function ($w) use ($infoId) {
            foreach (self::OP_INFO_FIELDS as $f) $w->orWhere($f, $infoId);
        })->count();
    }

    private function locked($date): bool
    {
        return $this->lockDate && Carbon::parse($date)->toDateString() <= $this->lockDate;
    }

    private function dateText($date): string
    {
        return Carbon::parse($date)->format('d.m.Y');
    }

    private function fail(string $message, array $problems = []): array
    {
        return ['ok' => false, 'message' => $message, 'problems' => $problems];
    }
}
