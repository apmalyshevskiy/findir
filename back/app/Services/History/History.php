<?php

namespace App\Services\History;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Запись истории изменений.
 *
 * Живёт синглтоном на запрос и держит контекст: кто правит и откуда пришло
 * изменение. Поэтому запись идёт через приложение, а не триггером базы:
 * триггер поймал бы вообще всё, но не знает ни человека, ни причины, а в
 * журнале изменений именно это и ищут.
 *
 * Плата за такой выбор — массовые `UPDATE` через построитель запросов мимо
 * моделей событий не поднимают. Таких мест наперечёт, и они зовут `record()`
 * сами.
 */
class History
{
    /** Поля, которые не считаем изменением: они меняются при каждом сохранении */
    private const IGNORED = ['updated_at', 'created_at'];

    private ?int $userId = null;
    private string $source = 'manual';
    private ?string $batch = null;

    /** Запись выключена: восстановление снимка само решает, что записать */
    private bool $paused = false;

    public function actor(?int $userId): void
    {
        $this->userId = $userId;
    }

    public function userId(): ?int
    {
        return $this->userId;
    }

    /**
     * Откуда идут изменения дальше по ходу запроса.
     *
     * Новая пачка на каждый вызов: одно действие человека — одна пачка, и
     * журнал сможет свернуть двадцать девять правок из 1С в одну строку.
     */
    public function source(string $source, bool $newBatch = true): void
    {
        $this->source = $source;
        if ($newBatch) $this->batch = (string) Str::ulid();
    }

    public function batch(): ?string
    {
        return $this->batch;
    }

    /** Выполнить без записи истории: нужно восстановлению, оно пишет версию само */
    public function silently(callable $fn)
    {
        $was = $this->paused;
        $this->paused = true;

        try     { return $fn(); }
        finally { $this->paused = $was; }
    }

    /**
     * Записать версию объекта.
     *
     * @param array      $diff     Готовая разница; пусто — посчитаем по самой модели.
     *                             Передают её массовые правки: там модель уже
     *                             сохранена, и спросить её «что поменялось» поздно.
     * @param array|null $snapshot Готовый снимок вместо текущего состояния. Нужен
     *                             удалению составного объекта: после удаления
     *                             частей их уже не прочитать.
     */
    public function record(
        Model $model,
        string $action,
        array $diff = [],
        ?int $restoredFrom = null,
        ?array $snapshot = null,
    ): void {
        if ($this->paused) return;

        $entity = $model->historyEntity();
        $id     = (int) $model->getKey();

        if ($action === 'updated' && !$diff) {
            $diff = $this->diffOf($model);

            // Сохранение, ничего не изменившее, версией не считаем: иначе
            // журнал наполнится строками «ничего», и в нём пропадёт смысл
            if (!$diff) return;
        }

        $conn = $model->getConnectionName();

        DB::connection($conn)->table('object_versions')->insert([
            'entity'        => $entity,
            'entity_id'     => $id,
            'version'       => $this->nextVersion($conn, $entity, $id),
            'action'        => $action,
            'diff'          => json_encode(array_values($diff), JSON_UNESCAPED_UNICODE),
            'snapshot'      => json_encode($snapshot ?? $model->historySnapshot(), JSON_UNESCAPED_UNICODE),
            'source'        => $this->source,
            'batch'         => $this->batch,
            'user_id'       => $this->userId,
            'restored_from' => $restoredFrom,
            'created_at'    => now(),
        ]);
    }

    /**
     * Записать версию, сравнив с заранее снятым состоянием.
     *
     * Для составных объектов: документ сохраняется шапкой и строками, и «что
     * изменилось» можно узнать только сравнив снимки до и после. Пустая
     * разница у обновления — не версия, как и везде.
     */
    public function recordFrom(Model $model, array $before, string $action = 'updated', ?int $restoredFrom = null): void
    {
        if ($this->paused) return;

        $diff = $action === 'created' ? [] : $this->diffSnapshots($before, $model->historySnapshot());

        if ($action === 'updated' && !$diff) return;

        $this->record($model, $action, $diff, $restoredFrom);
    }

    /** Разница двух снимков: поля, которых нет в одном из них, тоже считаются */
    private function diffSnapshots(array $before, array $after): array
    {
        $out = [];

        foreach (array_keys($before + $after) as $field) {
            if (in_array($field, self::IGNORED, true)) continue;

            $was = $before[$field] ?? null;
            $now = $after[$field]  ?? null;

            // Строки документа сравниваем целиком: для журнала важно, что
            // состав менялся, а разбор по строкам — работа для показа версии
            $same = is_array($was) || is_array($now)
                ? json_encode($was) === json_encode($now)
                : (string) $was === (string) $now;

            if (!$same) $out[] = ['field' => $field, 'was' => $was, 'now' => $now];
        }

        return $out;
    }

    /** Разница по самой модели: что она сохранила и что было до того */
    private function diffOf(Model $model): array
    {
        $out = [];

        foreach ($model->getChanges() as $field => $now) {
            if (in_array($field, self::IGNORED, true)) continue;

            $was = $model->getOriginal($field);

            // Приведение типов ради «1000» против 1000.0: база возвращает
            // строки, модель — числа, и без сравнения по значению журнал
            // показывал бы изменения там, где их нет
            if ((string) $was === (string) $now) continue;

            $out[] = ['field' => $field, 'was' => $was, 'now' => $now];
        }

        return $out;
    }

    private function nextVersion(?string $conn, string $entity, int $id): int
    {
        return 1 + (int) DB::connection($conn)->table('object_versions')
            ->where('entity', $entity)->where('entity_id', $id)
            ->max('version');
    }
}
