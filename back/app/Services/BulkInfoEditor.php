<?php

namespace App\Services;

use App\Models\Tenant\Info;
use App\Services\History\History;
use Illuminate\Support\Facades\DB;

/**
 * Массовая правка элементов справочника.
 *
 * Зачем: справочник наполняют шаблоном или загрузкой из 1С, а раскладывают по
 * группам потом — сорок статей по одной через карточку это работа на вечер.
 *
 * Правится только то, что не меняет природу элемента: родитель и вид (расхода
 * или деятельности). Ни имя, ни справочник массово не трогаем — первое у
 * каждого своё, второе запрещено там, где на элемент ссылаются.
 *
 * Пачка всегда одного справочника. Разнородный набор пришлось бы проверять
 * поэлементно, а человек всё равно правит статьи со статьями: список на
 * странице и так отфильтрован по виду.
 */
final class BulkInfoEditor
{
    public const FIELDS = ['parent_id', 'expense_kind', 'flow_kind'];

    /** Какому справочнику какое поле имеет смысл менять */
    public const FIELD_TYPES = [
        'expense_kind' => 'expenses',
        'flow_kind'    => 'flow',
    ];

    public const SKIP_LABELS = [
        'self'     => 'родитель — сам себе',
        'cycle'    => 'родитель внутри собственной ветки',
        'nochange' => 'уже с такими значениями',
    ];

    /** Что произойдёт, без изменения данных */
    public function preview(string $db, array $ids, array $set): array
    {
        $plan = $this->plan($db, $ids, $set);

        $skipped = [];
        $willUpdate = 0;
        foreach ($plan as $p) {
            if ($p['skip']) $skipped[$p['skip']] = ($skipped[$p['skip']] ?? 0) + 1;
            else $willUpdate++;
        }

        return [
            'total'       => count($ids),
            'found'       => count($plan),
            'will_update' => $willUpdate,
            'skipped'     => $skipped,
            'description' => $this->describe($db, $set),
        ];
    }

    /** Применить правку */
    public function apply(string $db, array $ids, array $set): array
    {
        $plan    = $this->plan($db, $ids, $set);
        $skipped = [];
        $updated = 0;

        DB::connection($db)->transaction(function () use ($db, $plan, &$skipped, &$updated) {
            foreach ($plan as $p) {
                if ($p['skip']) {
                    $skipped[$p['skip']] = ($skipped[$p['skip']] ?? 0) + 1;
                    continue;
                }

                // Через модель, а не запросом: история элемента ведётся её
                // событиями, и обойти их значило бы потерять запись о правке —
                // а вернуть элемент к прежнему виду люди захотят именно оттуда
                $info = Info::on($db)->find($p['id']);
                if (!$info) continue;

                $info->update($p['patch']);
                $updated++;
            }
        });

        return ['updated' => $updated, 'skipped' => $skipped];
    }

    /** Тип справочника у пачки: одинаковый у всех или null */
    public function commonType(string $db, array $ids): ?string
    {
        $types = Info::on($db)->whereIn('id', $ids)->whereNull('deleted_at')
            ->distinct()->pluck('type');

        return $types->count() === 1 ? (string) $types->first() : null;
    }

    // ── Внутреннее ───────────────────────────────────────────────────────────

    /** Что изменится в каждом элементе. Данные не трогает */
    private function plan(string $db, array $ids, array $set): array
    {
        $items = Info::on($db)->whereIn('id', $ids)->whereNull('deleted_at')
            ->get(['id', 'name', 'type', 'parent_id', 'expense_kind', 'flow_kind']);

        $patchBase = array_intersect_key($set, array_flip(self::FIELDS));
        $parentId  = array_key_exists('parent_id', $patchBase) ? $patchBase['parent_id'] : false;

        // Потомки каждого выбранного — чтобы не увести ветку саму под себя
        $children = $this->childrenMap($db);

        $plan = [];
        foreach ($items as $item) {
            $patch = $patchBase;

            if ($parentId !== false && $parentId !== null) {
                if ((int) $parentId === (int) $item->id) {
                    $plan[] = ['id' => $item->id, 'skip' => 'self'];
                    continue;
                }

                // Новый родитель не может лежать в поддереве переносимого:
                // ветка замкнулась бы сама на себя и пропала из дерева
                if (in_array((int) $parentId, $this->descendants($children, (int) $item->id), true)) {
                    $plan[] = ['id' => $item->id, 'skip' => 'cycle'];
                    continue;
                }
            }

            foreach ($patch as $field => $value) {
                if ((string) ($item->{$field} ?? '') === (string) ($value ?? '')) unset($patch[$field]);
            }

            if (!$patch) {
                $plan[] = ['id' => $item->id, 'skip' => 'nochange'];
                continue;
            }

            $plan[] = ['id' => $item->id, 'patch' => $patch, 'skip' => null];
        }

        return $plan;
    }

    /** id родителя → его прямые дети. Справочник маленький, читаем целиком */
    private function childrenMap(string $db): array
    {
        $map = [];
        foreach (DB::connection($db)->table('info')->whereNull('deleted_at')->get(['id', 'parent_id']) as $row) {
            $map[(int) $row->parent_id][] = (int) $row->id;
        }

        return $map;
    }

    /** Всё поддерево элемента. Уже пройденный id второй раз в очередь не попадает */
    private function descendants(array $children, int $id): array
    {
        $out   = [];
        $queue = $children[$id] ?? [];

        while ($queue) {
            $current = array_shift($queue);
            if (in_array($current, $out, true)) continue;

            $out[] = $current;
            foreach ($children[$current] ?? [] as $child) $queue[] = $child;
        }

        return $out;
    }

    private function describe(string $db, array $set): string
    {
        $parts = [];

        if (array_key_exists('parent_id', $set)) {
            $name = $set['parent_id']
                ? DB::connection($db)->table('info')->where('id', $set['parent_id'])->value('name')
                : null;
            $parts[] = 'родитель → ' . ($name ?: 'без родителя');
        }

        $kinds = [
            'expense_kind' => ['fixed' => 'постоянная', 'variable' => 'переменная', 'investment' => 'инвестиционная'],
            'flow_kind'    => ['operating' => 'операционная', 'investing' => 'инвестиционная', 'financing' => 'финансовая'],
        ];

        foreach (['expense_kind' => 'вид расхода', 'flow_kind' => 'вид деятельности'] as $field => $label) {
            if (!array_key_exists($field, $set)) continue;
            $parts[] = "$label → " . ($kinds[$field][$set[$field]] ?? $set[$field]);
        }

        return implode('; ', $parts);
    }
}
