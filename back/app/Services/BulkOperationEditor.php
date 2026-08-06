<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/**
 * Массовая правка выбранных операций.
 *
 * В отличие от правки по фильтру (её готовит ИИ), здесь список операций задаёт
 * пользователь галочками — поэтому «слишком широкое условие» невозможно и
 * дополнительных предохранителей от него не нужно.
 *
 * Что делает по-настоящему нетривиального:
 *  - аналитика пишется в тот слот счёта, который объявлен под этот тип
 *    (info_N_type), а не в первый попавшийся;
 *  - при смене счёта слоты, чей тип аналитики у нового счёта другой,
 *    очищаются — иначе id контрагента остался бы лежать в слоте, который
 *    новый счёт трактует как «статья ДДС», и отчёты начали бы врать;
 *  - каждая правка пишет прежние значения в bulk_update_log, поэтому откат
 *    работает тем же механизмом, что и у правок от ИИ.
 *
 * Новый реквизит добавляется одной строкой в FIELDS (плюс валидация в контроллере).
 */
final class BulkOperationEditor
{
    /** Плоские поля операции, доступные для массовой правки. */
    public const FIELDS = ['in_bi_id', 'out_bi_id', 'project_id', 'content', 'note'];

    public const ANALYTIC_TYPES = ['partner', 'employee', 'department', 'cash', 'flow', 'expenses', 'product', 'revenue'];

    /** Причины, по которым операция не будет изменена. */
    public const SKIP_LABELS = [
        'locked'       => 'в закрытом периоде',
        'document'     => 'созданы из документов',
        'same_account' => 'дебет совпал бы с кредитом',
        'no_slot'      => 'у счетов нет такой аналитики',
        'nochange'     => 'уже с такими значениями',
    ];

    /** Что произойдёт, без изменения данных. */
    public function preview(string $db, array $ids, array $set, string $side, ?string $lock): array
    {
        $plan    = $this->plan($db, $ids, $set, $side, $lock);
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
            'description' => $this->describe($db, $set, $side),
        ];
    }

    /** Применить правку. Возвращает [обновлено, пропущено по причинам, id журнала]. */
    public function apply(string $db, array $ids, array $set, string $side, ?string $lock): array
    {
        $plan    = $this->plan($db, $ids, $set, $side, $lock);
        $undo    = [];
        $skipped = [];
        $updated = 0;

        DB::connection($db)->transaction(function () use ($db, $plan, &$undo, &$skipped, &$updated) {
            foreach ($plan as $p) {
                if ($p['skip']) {
                    $skipped[$p['skip']] = ($skipped[$p['skip']] ?? 0) + 1;
                    continue;
                }
                DB::connection($db)->table('operations')->where('id', $p['id'])
                    ->update($p['patch'] + ['updated_at' => now()]);
                $undo[] = ['id' => $p['id'], 'before' => $p['before']];
                $updated++;
            }
        });

        $logId = null;
        if ($updated > 0) {
            $logId = $this->writeLog(
                $db,
                ['ids' => array_values($ids), 'side' => $side],
                $set,
                $undo,
                $updated,
                $updated . ' оп.: ' . $this->describe($db, $set, $side)
            );
        }

        return ['updated' => $updated, 'skipped' => $skipped, 'log_id' => $logId];
    }

    /** Откат массовой правки по журналу — общий для ручных правок и правок от ИИ. */
    public function revert(string $db, int $logId, ?string $lockDate = null): array
    {
        $log = DB::connection($db)->table('bulk_update_log')->where('id', $logId)->first();
        if (!$log)             return ['ok' => false, 'message' => 'Запись журнала не найдена'];
        if ($log->reverted_at) return ['ok' => false, 'message' => 'Эта правка уже откачена'];

        $undo = json_decode($log->undo, true) ?: [];
        $restored = 0;
        $skipped  = 0;

        foreach ($undo as $u) {
            $id     = $u['id'] ?? null;
            $before = $u['before'] ?? [];
            if (!$id || !$before) continue;

            $op = DB::connection($db)->table('operations')->where('id', $id)->whereNull('deleted_at')
                ->first(['id', 'date']);
            if (!$op) { $skipped++; continue; }                       // операция удалена
            if ($lockDate && substr((string) $op->date, 0, 10) <= $lockDate) { $skipped++; continue; }

            DB::connection($db)->table('operations')->where('id', $id)
                ->update($before + ['updated_at' => now()]);
            $restored++;
        }

        DB::connection($db)->table('bulk_update_log')->where('id', $logId)
            ->update(['reverted_at' => now(), 'updated_at' => now()]);

        return ['ok' => true, 'restored' => $restored, 'skipped' => $skipped];
    }

    public function writeLog(string $db, array $filter, array $set, array $undo, int $affected, string $description): int
    {
        return DB::connection($db)->table('bulk_update_log')->insertGetId([
            'filter'      => json_encode($filter, JSON_UNESCAPED_UNICODE),
            'changes_set' => json_encode($set, JSON_UNESCAPED_UNICODE),
            'undo'        => json_encode($undo, JSON_UNESCAPED_UNICODE),
            'affected'    => $affected,
            'description' => mb_substr($description, 0, 500),
            'created_at'  => now(),
            'updated_at'  => now(),
        ]);
    }

    // ── Внутреннее ────────────────────────────────────────────────────────────

    /**
     * Что именно изменится в каждой операции. Данные не трогает —
     * один и тот же расчёт использует и предпросмотр, и применение.
     */
    private function plan(string $db, array $ids, array $set, string $side, ?string $lock): array
    {
        $accounts = DB::connection($db)->table('balance_items')
            ->get(['id', 'code', 'name', 'info_1_type', 'info_2_type', 'info_3_type'])->keyBy('id');

        $ops = DB::connection($db)->table('operations')
            ->whereIn('id', $ids)->whereNull('deleted_at')
            ->get([
                'id', 'date', 'table_name', 'table_id', 'project_id', 'content', 'note',
                'in_bi_id', 'out_bi_id',
                'in_info_1_id', 'in_info_2_id', 'in_info_3_id',
                'out_info_1_id', 'out_info_2_id', 'out_info_3_id',
            ]);

        $flat      = array_intersect_key($set, array_flip(self::FIELDS));
        $analytics = $this->validAnalytics($db, $set['analytics'] ?? []);

        $plan = [];
        foreach ($ops as $op) {
            if ($lock && substr((string) $op->date, 0, 10) <= $lock) {
                $plan[] = ['id' => $op->id, 'skip' => 'locked'];
                continue;
            }
            // Операция из документа — её значения пересчитает проведение документа
            if ($op->table_name === 'documents' && $op->table_id) {
                $plan[] = ['id' => $op->id, 'skip' => 'document'];
                continue;
            }

            $patch = $flat;

            // Счета после правки — от них зависит и раскладка аналитики
            $eff = [
                'in'  => (int) ($patch['in_bi_id']  ?? $op->in_bi_id),
                'out' => (int) ($patch['out_bi_id'] ?? $op->out_bi_id),
            ];
            if ($eff['in'] === $eff['out']) {
                $plan[] = ['id' => $op->id, 'skip' => 'same_account'];
                continue;
            }

            // Смена счёта: слоты с другим типом аналитики очищаем, иначе id
            // из старого справочника будет прочитан как значение чужого типа
            foreach (['in', 'out'] as $p) {
                $oldId = (int) $op->{"{$p}_bi_id"};
                if ($eff[$p] === $oldId) continue;

                $new = $accounts[$eff[$p]] ?? null;
                $old = $accounts[$oldId]   ?? null;
                foreach ([1, 2, 3] as $n) {
                    if (($new->{"info_{$n}_type"} ?? null) !== ($old->{"info_{$n}_type"} ?? null)) {
                        $patch["{$p}_info_{$n}_id"] = null;
                    }
                }
            }

            // Аналитика — в слот, объявленный под этот тип
            $placed = 0;
            foreach ($analytics as $type => $infoId) {
                foreach (['in', 'out'] as $p) {
                    if ($side === 'debit'  && $p !== 'in')  continue;
                    if ($side === 'credit' && $p !== 'out') continue;

                    $acc = $accounts[$eff[$p]] ?? null;
                    if (!$acc) continue;

                    foreach ([1, 2, 3] as $n) {
                        if (($acc->{"info_{$n}_type"} ?? null) === $type) {
                            $patch["{$p}_info_{$n}_id"] = $infoId;
                            $placed++;
                            break;
                        }
                    }
                }
            }
            if ($analytics && !$placed && !$flat) {
                $plan[] = ['id' => $op->id, 'skip' => 'no_slot'];
                continue;
            }

            // Отбрасываем поля, которые и так такие; остальное запоминаем для отката
            $before = [];
            foreach ($patch as $field => $val) {
                $cur = $op->{$field} ?? null;
                if ($this->same($cur, $val)) { unset($patch[$field]); continue; }
                $before[$field] = $cur;
            }
            if (!$patch) {
                $plan[] = ['id' => $op->id, 'skip' => 'nochange'];
                continue;
            }

            $plan[] = ['id' => $op->id, 'patch' => $patch, 'before' => $before, 'skip' => null];
        }

        return $plan;
    }

    /**
     * Оставляем только аналитики, чей элемент действительно того типа.
     * Иначе id контрагента можно было бы записать в слот статьи ДДС.
     */
    private function validAnalytics(string $db, array $raw): array
    {
        $out = [];
        foreach ($raw as $type => $infoId) {
            if (!in_array($type, self::ANALYTIC_TYPES, true)) continue;

            if ($infoId === null || $infoId === '') {   // явная очистка слота
                $out[$type] = null;
                continue;
            }
            $ok = DB::connection($db)->table('info')
                ->where('id', $infoId)->where('type', $type)->whereNull('deleted_at')->exists();
            if ($ok) $out[$type] = (int) $infoId;
        }
        return $out;
    }

    /** null и '' считаем одним и тем же «пусто», числа сравниваем как строки. */
    private function same($a, $b): bool
    {
        return (string) ($a ?? '') === (string) ($b ?? '');
    }

    private function describe(string $db, array $set, string $side): string
    {
        $parts = [];

        foreach (['in_bi_id' => 'счёт дебета', 'out_bi_id' => 'счёт кредита'] as $f => $label) {
            if (!array_key_exists($f, $set)) continue;
            $code = DB::connection($db)->table('balance_items')->where('id', $set[$f])->value('code');
            $parts[] = "$label → " . ($code ?: '—');
        }

        if (array_key_exists('project_id', $set)) {
            $name = DB::connection($db)->table('projects')->where('id', $set['project_id'])->value('name');
            $parts[] = 'проект → ' . ($name ?: '—');
        }

        foreach (['content' => 'содержание', 'note' => 'примечание'] as $f => $label) {
            if (array_key_exists($f, $set)) {
                $parts[] = "$label → " . ($set[$f] === null || $set[$f] === '' ? 'очистить' : mb_substr((string) $set[$f], 0, 40));
            }
        }

        foreach (($set['analytics'] ?? []) as $type => $infoId) {
            $name = $infoId
                ? DB::connection($db)->table('info')->where('id', $infoId)->value('name')
                : null;
            $parts[] = "$type → " . ($name ?: 'очистить');
        }

        $sideLabel = ['debit' => ' (дебет)', 'credit' => ' (кредит)'][$side] ?? '';

        return implode('; ', $parts) . $sideLabel;
    }
}
