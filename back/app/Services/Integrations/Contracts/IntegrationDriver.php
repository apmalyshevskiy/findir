<?php

namespace App\Services\Integrations\Contracts;

use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationRun;

/**
 * Драйвер учётной системы.
 *
 * Всё, что знает о конкретном источнике — здесь. Добавление новой системы
 * должно сводиться к новому классу-драйверу и записи в реестре, без правок
 * контроллера, миграций и фронтенда.
 */
interface IntegrationDriver
{
    /**
     * Проверка связи. Возвращает короткое человеческое описание того, с чем
     * соединились («14 складов, 3 юрлица»), либо бросает исключение с
     * объяснимой причиной.
     */
    public function testConnection(Integration $integration): string;

    /**
     * Приведение доступов к каноническому виду перед сохранением.
     *
     * Человек вводит адрес как придётся — со схемой, с путём, одним номером;
     * храним и показываем в форме одно и то же, иначе поле «прыгает» между
     * сохранениями.
     */
    public function normalizeCredentials(array $credentials): array;

    /**
     * Справочники внешней системы для заполнения настроек: склады, юрлица и
     * прочее, что человеку нужно выбрать из списка, а не вводить числом.
     *
     * @return array<string, array<int, array{id: mixed, name: string}>>
     */
    public function dictionaries(Integration $integration): array;

    /**
     * Сущности, которые драйвер умеет загружать: ключ => название.
     *
     * @return array<string, string>
     */
    public function entities(): array;

    /**
     * Загрузка за период. Пишет в переданный прогон счётчики и предупреждения.
     */
    public function sync(Integration $integration, IntegrationRun $run, string $from, string $to): void;
}
