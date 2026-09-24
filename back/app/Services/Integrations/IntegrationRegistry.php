<?php

namespace App\Services\Integrations;

use App\Models\Tenant\Integration;
use App\Services\Integrations\Contracts\IntegrationDriver;
use App\Services\Integrations\FusionPos\FusionPosDriver;
use App\Services\Integrations\OneC\OneCBp3FileDriver;
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
 *
 * Имя типа складывается из системы, конфигурации и способа обмена:
 * `onec_bp3_file` — 1С, Бухгалтерия 3.0, обмен файлом. У одной системы бывает
 * несколько конфигураций и несколько способов связи, и завтрашний
 * `onec_bp3_http` должен встать рядом, а не переименовывать сегодняшнее.
 *
 * `kind` описывает способ обмена для интерфейса: `file` означает, что связи нет
 * и загрузка идёт со своего экрана. Фронт смотрит на этот признак, а не
 * разбирает имя типа на части.
 */
final class IntegrationRegistry
{
    public static function types(): array
    {
        return [
            'onec_bp3_file' => [
                'label'       => '1С:Бухгалтерия 3.0 (файл)',
                'description' => 'Проводки из файла выгрузки — файл готовит внешняя обработка в 1С',
                'kind'        => 'file',
                'entities'    => ['posting' => 'Проводки'],
                'credentials' => [],
                'settings'    => [
                    [
                        'key' => 'project_id', 'label' => 'Проект', 'kind' => 'project', 'required' => true,
                        'hint' => 'В проводках 1С проектов нет — все загруженные лягут на этот',
                    ],
                ],
            ],
            'fusionpos' => [
                'label'       => 'FUSIONPOS',
                'description' => 'Приходные накладные со складов и продажи по кассовым сменам',
                'kind'        => 'api',
                'entities'    => [
                    'warehouse_invoice' => 'Приходные накладные',
                    'pos_shift'         => 'Продажи по сменам',
                ],
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

                    // ── Продажи по сменам ──────────────────────────────
                    [
                        'key' => 'sales_customer_id', 'label' => 'Покупатель',
                        'kind' => 'info', 'info_type' => 'partner',
                        'hint' => 'В кассе покупателя нет — вся розница ложится на одного, '
                                . 'например «Физлица»',
                    ],
                    [
                        'key' => 'sales_revenue_bi_id', 'label' => 'Счёт доходов',
                        'kind' => 'balance_item', 'codes' => ['П587'],
                        'hint' => 'Куда идёт выручка смены',
                    ],
                    [
                        'key' => 'sales_cogs_bi_id', 'label' => 'Счёт себестоимости',
                        'kind' => 'balance_item', 'codes' => ['П588'],
                        'hint' => 'Куда идёт себестоимость проданного',
                    ],
                    [
                        'key' => 'shift_date_field', 'label' => 'Дата смены', 'kind' => 'select',
                        'options' => [
                            ['value' => 'created_at', 'label' => 'Дата открытия смены'],
                            ['value' => 'closed_at',  'label' => 'Дата закрытия смены'],
                        ],
                        'default' => 'created_at',
                        'hint' => 'Смена, открытая вечером и закрытая утром, обычно считается '
                                . 'сменой за первый день',
                    ],
                    [
                        'key' => 'only_closed_shifts', 'label' => 'Только закрытые смены',
                        'kind' => 'checkbox', 'default' => true,
                        'hint' => 'В открытую смену чеки ещё придут, и документ пришлось бы '
                                . 'перепроводить после каждой продажи',
                    ],

                    // Точки заведения различаются всем: своя статья дохода,
                    // свой склад, своя касса. Поэтому не поля, а таблица —
                    // строка на точку. Точка без заполненной строки не грузится,
                    // и отдельный фильтр «какие точки брать» не нужен
                    [
                        'key' => 'point_map', 'label' => 'Точки продаж', 'kind' => 'remote_table',
                        'source' => 'points', 'row_label' => 'Точка',
                        'columns' => [
                            [
                                'key' => 'revenue_item_id', 'label' => 'Статья дохода',
                                'kind' => 'info', 'info_type' => 'revenue',
                            ],
                            [
                                'key' => 'line_bi_id', 'label' => 'Счёт списания',
                                'kind' => 'balance_item', 'codes' => ['А200', 'А230', 'А240'],
                            ],
                            [
                                'key' => 'product_id', 'label' => 'Номенклатура',
                                'kind' => 'info', 'info_type' => 'product',
                            ],
                            // Необязателен: отдел проставляется только тем
                            // счетам, которые сами объявили под него слот
                            [
                                'key' => 'department_id', 'label' => 'Отдел',
                                'kind' => 'info', 'info_type' => 'department',
                            ],
                        ],
                        'hint' => 'Смены незаполненных точек в учёт не берутся. Счёт списания — '
                                . 'обычно тот же, на который приходуются накладные. Отдел '
                                . 'проставится в доходах, себестоимости и налоге — на тех счетах, '
                                . 'где заведён слот аналитики «Отдел»',
                    ],

                    // Оплаты — строка на пару «точка × тип оплаты»: наличные
                    // Ресторана 1 идут в свою кассу, а карта — на своего
                    // эквайера. Новый тип оплаты в кассе просто добавит строку
                    [
                        'key' => 'payment_map', 'label' => 'Чем закрывается долг покупателя',
                        'kind' => 'remote_table', 'source' => 'pointPayments', 'row_label' => 'Точка и оплата',
                        'columns' => [
                            [
                                'key' => 'bi_id', 'label' => 'Счёт',
                                'kind' => 'balance_item', 'codes' => ['А100', 'А300', 'А310'],
                            ],
                            [
                                'key' => 'info_1_id', 'label' => 'Аналитика',
                                'kind' => 'info_of_account', 'account' => 'bi_id',
                            ],
                            [
                                'key' => 'flow_id', 'label' => 'Статья ДДС',
                                'kind' => 'info', 'info_type' => 'flow',
                            ],
                        ],
                        'hint' => 'Наличные — А100 и касса точки, карта — А300 и банк-эквайер. '
                                . 'Статья ДДС нужна только счетам с денежным потоком',
                    ],

                    // ── Налог с продажи ────────────────────────────────
                    // В чеках FUSIONPOS налога сегодня нет: касса на УСН
                    // отдаёт пустое поле. Проводка появится сама, когда он
                    // появится в чеках, — если счета заполнены
                    [
                        'key' => 'vat_bi_id', 'label' => 'Счёт налога', 'kind' => 'balance_item',
                        'codes' => ['П589'],
                        'hint' => 'Заполняйте, если в чеках есть НДС. Пусто — проводки по налогу не будет',
                    ],
                    [
                        'key' => 'vat_item_id', 'label' => 'Статья расхода на налог',
                        'kind' => 'info', 'info_type' => 'expenses',
                    ],
                    [
                        'key' => 'vat_head_bi_id', 'label' => 'Счёт обязательства по налогу',
                        'kind' => 'balance_item', 'codes' => ['П340'],
                    ],
                    [
                        'key' => 'vat_partner_id', 'label' => 'Получатель налога',
                        'kind' => 'info', 'info_type' => 'partner',
                        'hint' => 'Обычно «Государство»',
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
            'fusionpos'     => app(FusionPosDriver::class),
            'onec_bp3_file' => app(OneCBp3FileDriver::class),
            default         => throw new RuntimeException("Нет драйвера для типа: {$type}"),
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
