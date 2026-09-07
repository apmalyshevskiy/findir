<?php

namespace App\Services\Integrations\OneC;

use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationRun;
use App\Services\Integrations\Contracts\IntegrationDriver;
use RuntimeException;

/**
 * 1С:Бухгалтерия 3.0 — обмен файлом.
 *
 * Драйвер существует не ради загрузки: её делает
 * [PostingsImporter](../../OneC/PostingsImporter.php) со своего экрана, потому
 * что файл приносит человек, а не сеть. Нужен он ради того, чтобы 1С была
 * обычной интеграцией: строка в `integrations`, настройки по общей схеме,
 * журнал прогонов и — главное — настоящий `integration_id`, по которому в
 * `integration_links` ложатся привязки счетов и аналитики.
 *
 * Сетевые методы честно отказываются работать. Контроллер интеграций ловит
 * исключение и отдаёт текст человеку, поэтому «Проверить связь» на 1С скажет,
 * в чём дело, вместо того чтобы молча ничего не сделать.
 */
final class OneCBp3FileDriver implements IntegrationDriver
{
    /** Что умеет грузить. Ключ совпадает с `entity` в журнале прогонов. */
    public const ENTITY = 'posting';

    private const NOT_NETWORK = '1С не подключается по сети: проводки загружаются '
        . 'файлом на странице «Обмен данными → Проводки из 1С». '
        . 'Файл готовит внешняя обработка «Выгрузка проводок в FINDIR».';

    public function entities(): array
    {
        return [self::ENTITY => 'Проводки'];
    }

    /** Доступов нет: файл приносит человек, паролей у файла не бывает. */
    public function normalizeCredentials(array $credentials): array
    {
        return [];
    }

    public function testConnection(Integration $integration): string
    {
        throw new RuntimeException(self::NOT_NETWORK);
    }

    public function dictionaries(Integration $integration): array
    {
        throw new RuntimeException(self::NOT_NETWORK);
    }

    public function preview(Integration $integration, string $entity, string $from, string $to): array
    {
        throw new RuntimeException(self::NOT_NETWORK);
    }

    public function object(Integration $integration, string $entity, string $externalId): array
    {
        throw new RuntimeException(self::NOT_NETWORK);
    }

    public function sync(Integration $integration, IntegrationRun $run, string $from, string $to, ?array $only = null): void
    {
        throw new RuntimeException(self::NOT_NETWORK);
    }
}
