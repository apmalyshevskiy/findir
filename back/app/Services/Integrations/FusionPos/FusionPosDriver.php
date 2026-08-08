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
        return [WarehouseInvoiceImporter::ENTITY => 'Приходные накладные'];
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

        $w = (int) data_get($warehouses, '_meta.totalCount', count($warehouses['items'] ?? []));
        $l = (int) data_get($entities,   '_meta.totalCount', count($entities['items'] ?? []));

        return "Связь есть: складов — {$w}, юрлиц — {$l}";
    }

    public function dictionaries(Integration $integration): array
    {
        $client = $this->client($integration);

        return [
            'warehouses'    => $this->list($client, 'warehouses'),
            'legalEntities' => $this->list($client, 'legal-entities'),
        ];
    }

    public function sync(Integration $integration, IntegrationRun $run, string $from, string $to): void
    {
        if ($run->entity !== WarehouseInvoiceImporter::ENTITY) {
            throw new RuntimeException("FUSIONPOS пока не умеет загружать: {$run->entity}");
        }

        (new WarehouseInvoiceImporter($this->client($integration), $integration))
            ->run($run, $from, $to);
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
