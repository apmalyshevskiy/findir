<?php

namespace App\Services\Integrations\FusionPos;

use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationRun;
use App\Services\Integrations\Contracts\IntegrationDriver;
use RuntimeException;

class FusionPosDriver implements IntegrationDriver
{
    public function entities(): array
    {
        return [
            WarehouseInvoiceImporter::ENTITY => 'Приходные накладные',
            ShiftSalesImporter::ENTITY       => 'Продажи по сменам',
        ];
    }

    /**
     * Колонки списка. У накладной и у смены они разные: у первой поставщик и
     * склад, у второй точка, число чеков и две суммы — выручка и
     * себестоимость. Описываем их здесь, чтобы страница загрузки не разбирала,
     * что за сущность перед ней.
     */
    public function columns(string $entity): array
    {
        if ($entity === ShiftSalesImporter::ENTITY) {
            return [
                ['key' => 'number',    'label' => 'Смена',         'kind' => 'text'],
                ['key' => 'date',      'label' => 'Дата',          'kind' => 'date'],
                ['key' => 'warehouse', 'label' => 'Точка',         'kind' => 'text'],
                ['key' => 'count',     'label' => 'Чеков',         'kind' => 'count'],
                ['key' => 'amount2',   'label' => 'Себестоимость', 'kind' => 'money'],
                ['key' => 'amount',    'label' => 'Выручка',       'kind' => 'money'],
            ];
        }

        return [
            ['key' => 'number',    'label' => 'Документ',  'kind' => 'text'],
            ['key' => 'date',      'label' => 'Дата',      'kind' => 'date'],
            ['key' => 'supplier',  'label' => 'Поставщик', 'kind' => 'partner'],
            ['key' => 'warehouse', 'label' => 'Склад',     'kind' => 'text'],
            ['key' => 'amount',    'label' => 'Сумма',     'kind' => 'money'],
        ];
    }

    /** Кабинет храним номером: «https://2791795.fusionpos.ru/» → «2791795». */
    public function normalizeCredentials(array $credentials): array
    {
        if (!empty($credentials['domain'])) {
            $credentials['domain'] = FusionPosClient::compactDomain($credentials['domain']);
        }
        return $credentials;
    }

    public function testConnection(Integration $integration): string
    {
        $client = $this->client($integration);

        $warehouses = $client->get('warehouses', ['per-page' => 1]);
        $entities   = $client->get('legal-entities', ['per-page' => 1]);
        $shifts     = $client->get('shifts', ['per-page' => 1]);

        $w = (int) data_get($warehouses, '_meta.totalCount', count($warehouses['items'] ?? []));
        $l = (int) data_get($entities,   '_meta.totalCount', count($entities['items'] ?? []));
        $s = (int) data_get($shifts,     '_meta.totalCount', count($shifts['items'] ?? []));

        return "Связь есть: складов — {$w}, юрлиц — {$l}, смен — {$s}";
    }

    public function dictionaries(Integration $integration): array
    {
        $client = $this->client($integration);

        $points   = $this->list($client, 'points');
        $payments = $this->list($client, 'payment-types');

        return [
            'warehouses'    => $this->list($client, 'warehouses'),
            'legalEntities' => $this->list($client, 'legal-entities'),
            'points'        => $points,
            // Пары «точка × тип оплаты» собираем здесь, а не в форме: наличные
            // Ресторана 1 идут в свою кассу, а карта — на своего эквайера, и
            // настраивается это именно парой. Форме достаточно списка строк
            'pointPayments' => $this->pointPayments($points, $payments),
        ];
    }

    /**
     * Пары «точка × тип оплаты» одним списком.
     *
     * Ключ составной — «точка:тип»: по нему загрузка находит настройку, зная
     * точку смены и тип оплаты чека.
     */
    private function pointPayments(array $points, array $payments): array
    {
        $out = [];

        foreach ($points as $point) {
            foreach ($payments as $payment) {
                $out[] = [
                    'id'   => $point['id'] . ':' . $payment['id'],
                    'name' => $point['name'] . ' · ' . $payment['name'],
                ];
            }
        }

        return $out;
    }

    public function preview(Integration $integration, string $entity, string $from, string $to): array
    {
        return $this->importer($integration, $entity)->preview($from, $to);
    }

    public function object(Integration $integration, string $entity, string $externalId): array
    {
        return $this->importer($integration, $entity)->describeOne($externalId);
    }

    public function sync(Integration $integration, IntegrationRun $run, string $from, string $to, ?array $only = null): void
    {
        $this->importer($integration, $run->entity)->run($run, $from, $to, $only);
    }

    /**
     * Загрузчик под сущность.
     *
     * Накладные и продажи ходят в разные разделы кассы и ложатся в разные
     * документы, общего у них только клиент — поэтому два класса, а не один с
     * развилками внутри.
     */
    private function importer(Integration $integration, string $entity): WarehouseInvoiceImporter|ShiftSalesImporter
    {
        $client = $this->client($integration);

        return match ($entity) {
            WarehouseInvoiceImporter::ENTITY => new WarehouseInvoiceImporter($client, $integration),
            ShiftSalesImporter::ENTITY       => new ShiftSalesImporter($client, $integration),
            default => throw new RuntimeException("FUSIONPOS пока не умеет загружать: {$entity}"),
        };
    }

    private function client(Integration $integration): FusionPosClient
    {
        $creds = $integration->credentials();

        if (empty($creds['domain']) || empty($creds['token'])) {
            throw new RuntimeException('Не заданы домен или токен FUSIONPOS');
        }

        return new FusionPosClient($creds['domain'], $creds['token']);
    }

    /** Плоский список «id — название» для выпадающих списков в настройках. */
    private function list(FusionPosClient $client, string $path): array
    {
        $out = [];
        $client->each($path, [], function (array $items) use (&$out) {
            foreach ($items as $row) {
                $out[] = [
                    'id'   => $row['id'] ?? null,
                    'name' => $row['name'] ?? ($row['reverse_name'] ?? ('#' . ($row['id'] ?? '?'))),
                ];
            }
        });
        return $out;
    }
}
