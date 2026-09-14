<?php

namespace App\Services\History;

/**
 * Модель, изменения которой попадают в журнал.
 *
 * События модели ловят всё, что идёт через Eloquent, — и ручную правку, и
 * импорт, и черновики помощника, — не требуя ничего помнить в каждом месте
 * записи. Мимо проходят только массовые `UPDATE` построителем запросов; такие
 * места зовут History::record() сами.
 */
trait HasHistory
{
    public static function bootHasHistory(): void
    {
        if (!static::historyAuto()) return;

        static::created(fn($model) => app(History::class)->record($model, 'created'));
        static::updated(fn($model) => app(History::class)->record($model, 'updated'));
        // Мягкое удаление сюда же: для человека это «удалили», а не «поправили
        // поле deleted_at»
        static::deleted(fn($model) => app(History::class)->record($model, 'deleted'));
    }

    /**
     * Писать ли версию автоматически на событиях модели.
     *
     * Составной объект отвечает «нет»: его событие приходит раньше, чем
     * сохранены части, и снимок получился бы без них. Такой объект пишет
     * версию сам — когда сохранение закончено целиком.
     */
    protected static function historyAuto(): bool
    {
        return true;
    }

    /** Имя вида объекта в журнале */
    abstract public function historyEntity(): string;

    /**
     * Полное состояние объекта после изменения.
     *
     * По умолчанию — собственные поля. Документ переопределяет: он состоит из
     * шапки и строк, и снимок без строк восстановить нечем.
     */
    public function historySnapshot(): array
    {
        return $this->attributesToArray();
    }
}
