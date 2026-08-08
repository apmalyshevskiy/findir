<?php

namespace App\Services\Integrations;

use App\Models\Tenant\Integration;
use App\Services\Integrations\Contracts\IntegrationDriver;
use App\Services\Integrations\FusionPos\FusionPosDriver;
use RuntimeException;

/**
 * Реестр учётных систем.
 *
 * Описание полей лежит здесь, а не в React: форма настроек собирается на
 * фронте по этой схеме. Иначе каждая новая система требовала бы своей формы,
 * и «интеграций может быть несколько» упёрлось бы в вёрстку.
 *
 * Виды полей, которые понимает фронт:
 *   text, password, checkbox, select (options),
 *   project      — выбор проекта FINDIR
 *   balance_item — счёт плана счетов (codes: подсказка допустимых)
 *   info         — элемент справочника (info_type: partner/product/...)
 *   remote_multi — множественный выбор из справочника внешней системы (source)
 */
final class IntegrationRegistry
{
    public static function types(): array
    {
        return [
            'fusionpos' => [
                'label'       => 'FUSIONPOS',
                'description' => 'Приходные накладные со складов FUSIONPOS',
                'entities'    => ['warehouse_invoice' => 'Приходные накладные'],
                'credentials' => [
                    [
                        'key'   => 'domain', 'label' => 'Кабинет', 'kind' => 'text', 'required' => true,
                        'hint'  => 'Номер кабинета, например 2791795 — адрес допишется сам',
                    ],
                    [
                        'key'   => 'token', 'label' => 'API-токен', 'kind' => 'password', 'required' => true,
                        'hint'  => 'Выпускается в FUSIONPOS. Хранится зашифрованным и обратно не показывается',
                    ],
                ],
                'settings' => [
                    [
                        'key' => 'project_id', 'label' => 'Проект', 'kind' => 'project', 'required' => true,
                        'hint' => 'Куда складывать загруженные накладные',
                    ],
                    [
                        'key' => 'line_bi_id', 'label' => 'Счёт прихода', 'kind' => 'balance_item', 'required' => true,
                        'codes' => ['А200', 'А230', 'А240'],
                        'hint'  => 'Дебет строки: товары, материалы или продукты',
                    ],
                    [
                        'key' => 'service_product_id', 'label' => 'Служебная номенклатура',
                        'kind' => 'info', 'info_type' => 'product', 'required' => true,
                        'hint' => 'Одна позиция, на которую приходуются все накладные',
                    ],
                    [
                        'key' => 'supplier_mode', 'label' => 'Поставщики', 'kind' => 'select', 'required' => true,
                        'options' => [
                            ['value' => 'by_inn', 'label' => 'Заводить по ИНН'],
                            ['value' => 'single', 'label' => 'Все на одного служебного'],
                        ],
                        'default' => 'by_inn',
                    ],
                    [
                        'key' => 'service_supplier_id', 'label' => 'Служебный поставщик',
                        'kind' => 'info', 'info_type' => 'partner', 'required' => true,
                        'hint' => 'Используется в режиме «на одного», а также когда у поставщика нет ИНН',
                    ],
                    [
                        'key' => 'date_field', 'label' => 'Дата документа', 'kind' => 'select',
                        'options' => [
                            ['value' => 'doc_date',     'label' => 'Дата документа поставщика'],
                            ['value' => 'processed_at', 'label' => 'Дата проведения на складе'],
                        ],
                        'default' => 'doc_date',
                        'hint' => 'Если у накладной нет даты поставщика, берётся дата проведения',
                    ],
                    [
                        'key' => 'only_processed', 'label' => 'Только проведённые накладные',
                        'kind' => 'checkbox', 'default' => true,
                    ],
                    [
                        'key' => 'post_documents', 'label' => 'Проводить сразу при загрузке',
                        'kind' => 'checkbox', 'default' => true,
                        'hint' => 'Снимите, если хотите просматривать накладные перед проведением',
                    ],
                    [
                        'key' => 'warehouse_ids', 'label' => 'Склады', 'kind' => 'remote_multi', 'source' => 'warehouses',
                        'hint' => 'Пусто — грузим со всех складов',
                    ],
                    [
                        'key' => 'legal_entity_ids', 'label' => 'Юрлица', 'kind' => 'remote_multi', 'source' => 'legalEntities',
                        'hint' => 'Пусто — грузим по всем юрлицам',
                    ],
                ],
            ],
        ];
    }

    public static function schema(string $type): array
    {
        $all = self::types();
        if (!isset($all[$type])) {
            throw new RuntimeException("Неизвестный тип интеграции: {$type}");
        }
        return $all[$type];
    }

    public static function driver(Integration|string $integration): IntegrationDriver
    {
        $type = is_string($integration) ? $integration : $integration->type;

        return match ($type) {
            'fusionpos' => app(FusionPosDriver::class),
            default     => throw new RuntimeException("Нет драйвера для типа: {$type}"),
        };
    }

    /** Значения по умолчанию для новой интеграции. */
    public static function defaults(string $type): array
    {
        $out = [];
        foreach (self::schema($type)['settings'] as $field) {
            if (array_key_exists('default', $field)) {
                $out[$field['key']] = $field['default'];
            }
        }
        return $out;
    }
}
