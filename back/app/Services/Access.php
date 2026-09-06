<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/**
 * Права доступа: разделы, уровни и карта маршрутов.
 *
 * До этого доступ проверялся ровно одним условием — есть ли действующий токен,
 * и любой вошедший мог всё: править чужие проводки, менять план счетов,
 * выгрузить всю базу архивной копией. Здесь появляется понятие раздела и
 * уровня, а должность превращает их в набор прав.
 *
 * Разделы намеренно повторяют пункты меню: настройка должности должна
 * читаться глазами, а не сверяться с документацией.
 */
class Access
{
    public const NONE = 'none';
    public const VIEW = 'view';
    public const EDIT = 'edit';

    /** Разделы в порядке меню */
    public static function sections(): array
    {
        return [
            'dashboard'    => 'Дашборд',
            'ai'           => 'AI-помощник',
            'operations'   => 'Операции',
            'documents'    => 'Документы',
            'reports'      => 'Отчёты и оборотка',
            'exchange'     => 'Обмен данными',
            'budget'       => 'Бюджет, календарь, фонды',
            'dictionaries' => 'Справочники и план счетов',
            'settings'     => 'Настройки',
            'users'        => 'Пользователи и должности',
            'backup'       => 'Архивная копия',
        ];
    }

    public static function levels(): array
    {
        return [
            self::NONE => 'Нет доступа',
            self::VIEW => 'Просмотр',
            self::EDIT => 'Изменение',
        ];
    }

    /**
     * Первый сегмент пути → раздел.
     *
     * Маршрутов больше сотни, но все они группируются по первому сегменту;
     * исключения перечислены ниже отдельно.
     */
    private static function routeMap(): array
    {
        return [
            'dashboard'              => 'dashboard',

            'ai'                     => 'ai',

            'operations'             => 'operations',
            'operation-templates'    => 'operations',

            'documents'              => 'documents',

            'balance-sheet'          => 'reports',

            'bank-statements'        => 'exchange',
            'integrations'           => 'exchange',

            'budget-documents'       => 'budget',
            'budget-items'           => 'budget',
            'budget-report'          => 'budget',
            'budget-opening-balances' => 'budget',
            'fund-schemes'           => 'budget',
            'fund-plan-docs'         => 'budget',
            'funds'                  => 'budget',

            'info'                   => 'dictionaries',
            'projects'               => 'dictionaries',
            'balance-items'          => 'dictionaries',
            'document-types'         => 'dictionaries',
            'dictionary-templates'   => 'dictionaries',
            'category-postings'      => 'dictionaries',
            'classification-rules'   => 'dictionaries',

            'settings'               => 'settings',

            'users'                  => 'users',
            'roles'                  => 'users',

            'backup'                 => 'backup',
        ];
    }

    /**
     * POST, которые ничего не меняют.
     *
     * Правило «GET — просмотр, остальное — изменение» ломается на расчётах и
     * предпросмотрах: они шлются POST'ом ради тела запроса, а не ради записи.
     * Без этого списка «Только просмотр» спотыкался бы на ровном месте.
     */
    private static function readOnlyPosts(): array
    {
        return [
            'operations/bulk-preview',
            'documents/calculate-cost',
            'backup/inspect',
            'bank-statements/parse',
        ];
    }

    /**
     * Записи, которые человек делает только про себя.
     *
     * Раскладка виджетов лежит в settings под ключом с id пользователя, то есть
     * чужой дашборд ею не тронуть. Запрещать её уровнем «просмотр» значило бы
     * не пускать человека переставить свои же плитки.
     */
    private static function personalWrites(): array
    {
        return [
            'dashboard/layout',
        ];
    }

    /**
     * Чтения, которые выносят данные наружу.
     *
     * Метод запроса ничего не говорит о весе действия: выгрузка архивной копии —
     * это вся база компании одним файлом, и уровня «просмотр» для неё мало.
     */
    private static function heavyReads(): array
    {
        return [
            'backup/export',
        ];
    }

    /**
     * Маршруты, живущие не в том разделе, что подсказывает первый сегмент.
     *
     * Счёт за помощника — это деньги компании, а не работа с помощником: видеть
     * трату должен тот, кто отвечает за настройки, даже если сам ИИ ему закрыт.
     */
    private static function sectionOverrides(): array
    {
        return [
            'ai/usage' => 'settings',
        ];
    }

    /**
     * Подсказки к разделам, где уровень читается неоднозначно.
     *
     * Показываются в матрице должности рядом с названием раздела.
     */
    public static function sectionHints(): array
    {
        return [
            'ai'     => 'Просмотр ничего не даёт: вопросы помощнику требуют уровня «изменение»',
            'backup' => 'Просмотр — сводка и проверка файла; изменение — выгрузка и загрузка копии',
        ];
    }

    /** Маршруты, доступные без прав: вход, регистрация, здоровье, выход */
    public static function isPublic(string $path): bool
    {
        $first = self::firstSegment($path);

        return in_array($first, ['health', 'register', 'login', 'logout', 'me', 'check-domain', 'suggest-domain'], true);
    }

    /** Раздел, к которому относится путь (или null — тогда доступ только админу) */
    public static function sectionFor(string $path): ?string
    {
        $clean = self::clean($path);

        return self::sectionOverrides()[$clean]
            ?? self::routeMap()[self::firstSegment($path)]
            ?? null;
    }

    /** Какой уровень нужен для этого запроса */
    public static function levelFor(string $method, string $path): string
    {
        $clean = self::clean($path);

        if (in_array($clean, self::personalWrites(), true)) {
            return self::VIEW;
        }

        if (in_array($clean, self::heavyReads(), true)) {
            return self::EDIT;
        }

        if (in_array(strtoupper($method), ['GET', 'HEAD', 'OPTIONS'], true)) {
            return self::VIEW;
        }

        foreach (self::readOnlyPosts() as $readOnly) {
            if ($clean === $readOnly) return self::VIEW;
        }

        // Предпросмотр, справочники и проверка связи у интеграции ничего не
        // пишут в учёт — они лишь показывают, что придёт
        if (preg_match('#^integrations/\d+/(preview|object|dictionaries|test)$#', $clean)) {
            return self::VIEW;
        }

        return self::EDIT;
    }

    /**
     * Разделы, в которых есть хоть один пишущий маршрут.
     *
     * Считаем по таблице маршрутов, а не списком: захардкоженный перечень
     * разошёлся бы с кодом при первом же новом маршруте, и в матрице снова
     * появился бы переключатель, за которым ничего нет.
     */
    public static function editableSections(): array
    {
        $out = [];

        foreach (app('router')->getRoutes() as $route) {
            // В таблице маршрутов на месте id стоит placeholder, а проверки в
            // levelFor написаны под живой путь с цифрами
            $path = str_replace(['{id}', '{key}'], '1', $route->uri());

            if (self::isPublic($path)) continue;
            if (!$section = self::sectionFor($path)) continue;
            if (isset($out[$section])) continue;

            foreach ($route->methods() as $method) {
                if (self::levelFor($method, $path) === self::EDIT) {
                    $out[$section] = true;
                    break;
                }
            }
        }

        return array_keys($out);
    }

    /** Хватает ли уровня: edit покрывает view, view не покрывает edit */
    public static function allows(string $granted, string $required): bool
    {
        $rank = [self::NONE => 0, self::VIEW => 1, self::EDIT => 2];

        return ($rank[$granted] ?? 0) >= ($rank[$required] ?? 2);
    }

    /**
     * Права пользователя тенанта: карта «раздел → уровень».
     *
     * Пользователь без должности прав не имеет вовсе — это осознанно: должность
     * выдаётся при создании, и её отсутствие означает недонастроенную учётку,
     * а не полный доступ.
     */
    public static function permissionsFor(string $db, int $userId): array
    {
        $row = DB::connection($db)->table('users as u')
            ->leftJoin('roles as r', 'r.id', '=', 'u.role_id')
            ->where('u.id', $userId)
            ->first(['u.is_active', 'r.code as role_code', 'r.name as role_name', 'r.permissions']);

        if (!$row || !$row->is_active) return [];

        $permissions = json_decode((string) $row->permissions, true) ?: [];

        // Полный набор разделов: отсутствующий в карте раздел — «нет доступа»
        $out = [];
        foreach (array_keys(self::sections()) as $section) {
            $out[$section] = $permissions[$section] ?? self::NONE;
        }

        return $out;
    }

    /** Заводские должности: администратор и только просмотр */
    public static function systemRoles(): array
    {
        $all  = array_keys(self::sections());
        $edit = array_fill_keys($all, self::EDIT);

        // Просмотр видит всё, кроме управления людьми и выгрузки базы: и то и
        // другое — не про «посмотреть цифры», а про доступ к системе целиком
        $view = array_fill_keys($all, self::VIEW);
        $view['users']  = self::NONE;
        $view['backup'] = self::NONE;
        $view['ai']     = self::NONE;   // каждый вопрос к ИИ стоит денег

        return [
            ['code' => 'admin',  'name' => 'Администратор',  'permissions' => $edit, 'is_system' => 1, 'sort_order' => 10],
            ['code' => 'viewer', 'name' => 'Только просмотр', 'permissions' => $view, 'is_system' => 1, 'sort_order' => 20],
        ];
    }

    /** Путь без префикса api/v1 и крайних слэшей */
    private static function clean(string $path): string
    {
        return trim(preg_replace('#^api/v1/#', '', $path), '/');
    }

    private static function firstSegment(string $path): string
    {
        $parts = explode('/', self::clean($path));

        return $parts[0] ?? '';
    }
}
