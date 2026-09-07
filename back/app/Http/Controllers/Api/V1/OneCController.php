<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationRun;
use App\Services\Integrations\IntegrationRegistry;
use App\Services\Integrations\OneC\OneCBp3FileDriver;
use App\Services\OneC\PostingsFile;
use App\Services\OneC\PostingsImporter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Загрузка проводок из 1С:Бухгалтерии.
 *
 * Файл выгружает обработка из папки 1c/ в корне репозитория; формат описан в
 * 1c/FORMAT.md. Сюда он попадает через форму — по сети 1С к нам не ходит,
 * поэтому у драйвера [OneCBp3FileDriver](../../../Services/Integrations/OneC/OneCBp3FileDriver.php)
 * сетевые методы отказываются работать, а вся загрузка живёт здесь.
 *
 * Интеграция всё равно настоящая: строка в `integrations` даёт настройки по
 * общей схеме, журнал прогонов и — главное — `integration_id`, под которым в
 * `integration_links` лежат привязки счетов и аналитики.
 *
 * Загрузка в два шага: сначала просмотр (ничего не пишется), потом отмеченные
 * проводки. Одной кнопкой «взять всё» пользоваться страшно — из файла за месяц
 * получаются сотни операций.
 */
class OneCController extends TenantController
{
    private const TYPE = 'onec_bp3_file';

    /** Файл за месяц — сотни килобайт; 20 МБ хватает с запасом на год. */
    private const MAX_FILE_KB = 20480;

    /**
     * GET /onec/settings
     *
     * Интеграции 1С, привязка счетов выбранной и проекты для настройки.
     */
    public function settings(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $integration = $this->resolve($request);

        return response()->json([
            'data' => [
                'integrations'   => $this->list(),
                'integration_id' => $integration?->id,
                'project_id'     => $integration ? $this->projectId($integration) : null,
                'accounts'       => $integration ? $this->accountMap($integration) : [],
                'projects'       => DB::connection($this->dbName)->table('projects')
                    ->whereNull('deleted_at')->orderBy('name')->select('id', 'name')->get(),
            ],
        ]);
    }

    /**
     * PUT /onec/settings — проект и привязка счетов.
     *
     * Привязка приходит целиком: таблица маленькая и правится вся сразу,
     * частичное обновление здесь только запутало бы.
     */
    public function saveSettings(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate([
            'integration_id'     => 'nullable|integer',
            'project_id'         => 'nullable|integer',
            'accounts'           => 'array',
            'accounts.*.account' => 'required|string|max:20',
            'accounts.*.mode'    => 'required|string|in:bind,skip,auto',
            'accounts.*.bi_id'   => 'nullable|integer',
        ]);

        $integration = $this->resolve($request);
        if (!$integration) return $this->noIntegration();

        $items = [];
        foreach ($data['accounts'] ?? [] as $row) {
            $account = trim((string) $row['account']);
            if ($account === '') continue;

            $items[] = [
                'external_id'   => $account,
                'external_name' => $account,
                'local_type'    => 'balance_item',
                'mode'          => $row['mode'],
                'local_id'      => $row['mode'] === 'bind' ? (int) ($row['bi_id'] ?? 0) : null,
            ];
        }

        if ($resp = $this->checkTargets($items, 'balance_items', 'счёт')) return $resp;

        DB::connection($this->dbName)->transaction(function () use ($integration, $items, $data) {
            $this->writeLinks($integration, PostingsImporter::ENTITY_ACCOUNT, $items);

            if (array_key_exists('project_id', $data)) {
                $integration->settings = array_merge(
                    $integration->settings ?: [],
                    ['project_id' => $data['project_id'] ? (int) $data['project_id'] : null],
                );
                $integration->save();
            }
        });

        return response()->json(['data' => [
            'integration_id' => $integration->id,
            'project_id'     => $this->projectId($integration),
            'accounts'       => $this->accountMap($integration),
        ]]);
    }

    /**
     * PUT /onec/analytics-map — привязка субконто.
     *
     * Три состояния, и они означают разное:
     *   bind — «это вот тот элемент справочника»;
     *   skip — «эту аналитику не переносить»;
     *   auto — привязки нет, работает поиск по ИНН и наименованию.
     */
    public function saveAnalytics(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate([
            'integration_id'  => 'nullable|integer',
            'items'           => 'array',
            'items.*.kind'    => 'required|string|max:64',
            'items.*.name'    => 'required|string|max:255',
            'items.*.mode'    => 'required|string|in:bind,skip,auto',
            'items.*.info_id' => 'nullable|integer',
        ]);

        $integration = $this->resolve($request);
        if (!$integration) return $this->noIntegration();

        $items = [];
        foreach ($data['items'] ?? [] as $row) {
            $items[] = [
                'external_id'   => PostingsImporter::subcontoKey($row['kind'], $row['name']),
                'external_name' => mb_substr($row['kind'] . ': ' . $row['name'], 0, 255),
                'local_type'    => 'info',
                'mode'          => $row['mode'],
                'local_id'      => $row['mode'] === 'bind' ? (int) ($row['info_id'] ?? 0) : null,
            ];
        }

        if ($resp = $this->checkTargets($items, 'info', 'элемент справочника')) return $resp;

        DB::connection($this->dbName)->transaction(
            fn() => $this->writeLinks($integration, PostingsImporter::ENTITY_SUBCONTO, $items)
        );

        return response()->json(['ok' => true, 'saved' => count($items)]);
    }

    /**
     * POST /onec/postings/preview
     *
     * Разбирает файл и показывает, что из него получится. В базу не пишет.
     */
    public function preview(Request $request)
    {
        $this->initTenant($request);

        $integration = $this->resolve($request);
        if (!$integration) return $this->noIntegration();

        $file = $this->readFile($request);
        if (!is_array($file)) return $file;

        $result = $this->importer($integration)->preview($file);

        return response()->json([
            'data' => $result + [
                'meta'           => $file['meta'],
                'problems'       => $file['problems'],
                'integration_id' => $integration->id,
                'project_id'     => $this->projectId($integration),
            ],
        ]);
    }

    /**
     * POST /onec/postings/import
     *
     * Создаёт операции по отмеченным проводкам. Файл присылается второй раз —
     * держать его между двумя запросами значило бы заводить хранилище ради
     * одной минуты жизни данных.
     */
    public function import(Request $request)
    {
        $this->initTenant($request);

        $request->validate(['only' => 'array', 'only.*' => 'string']);

        $integration = $this->resolve($request);
        if (!$integration) return $this->noIntegration();

        $file = $this->readFile($request);
        if (!is_array($file)) return $file;

        if (!$this->projectId($integration)) {
            return response()->json([
                'message' => 'Не выбран проект. Проводки 1С проекта не знают — его нужно указать до загрузки.',
            ], 422);
        }

        $period = $file['meta']['period'] ?? null;

        $run = (new IntegrationRun)->setConnection($this->dbName);
        $run->fill([
            'integration_id' => $integration->id,
            'entity'         => OneCBp3FileDriver::ENTITY,
            'mode'           => 'manual',
            'period_from'    => $period['from'] ?? null,
            'period_to'      => $period['to'] ?? null,
            'status'         => 'running',
            'started_at'     => now(),
            'fetched' => 0, 'created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0,
        ]);
        $run->save();

        @set_time_limit(300);

        $only = $request->input('only');

        try {
            $result = $this->importer($integration)->import($file, is_array($only) ? $only : null);

            foreach (['fetched', 'created', 'updated', 'skipped', 'failed'] as $k) {
                $run->{$k} = $result[$k] ?? 0;
            }
            $run->details = $result['warnings'] ?: null;
            $run->status  = $run->failed > 0 ? 'warning' : 'ok';
            $run->message = $this->summary($run);
        } catch (\Throwable $e) {
            $result = ['created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0, 'warnings' => []];
            $run->status  = 'error';
            $run->message = $e->getMessage();
        }

        $run->finished_at = now();
        $run->save();

        $integration->last_run_at      = $run->finished_at;
        $integration->last_run_status  = $run->status;
        $integration->last_run_message = $run->message;
        $integration->save();

        if ($run->status === 'error') {
            return response()->json(['message' => $run->message], 422);
        }

        return response()->json(['data' => $result]);
    }

    // ─── Приватные ───────────────────────────────────────────────────────────

    private function importer(Integration $integration): PostingsImporter
    {
        return new PostingsImporter(
            $this->dbName, $this->scope, $integration, $this->editLockDate(),
        );
    }

    /**
     * Интеграция запроса.
     *
     * Явный integration_id важнее: 1С-баз может быть несколько, и у каждой своя
     * привязка счетов. Когда она одна — не спрашиваем, лишний выбор из одного
     * варианта только мешает.
     */
    private function resolve(Request $request): ?Integration
    {
        $id = $request->input('integration_id');

        $query = Integration::on($this->dbName)->where('type', self::TYPE);

        if ($id) return (clone $query)->where('id', (int) $id)->first();

        return $query->where('is_active', true)->orderBy('id')->first();
    }

    private function noIntegration(): JsonResponse
    {
        return response()->json([
            'message' => 'Не настроена интеграция с 1С. Заведите её в «Обмен данными → '
                . 'Настройка интеграций», тип «' . IntegrationRegistry::schema(self::TYPE)['label'] . '».',
        ], 422);
    }

    private function list(): array
    {
        return Integration::on($this->dbName)->where('type', self::TYPE)
            ->orderBy('name')->get()
            ->map(fn($i) => [
                'id'         => $i->id,
                'name'       => $i->name,
                'is_active'  => (bool) $i->is_active,
                'project_id' => $this->projectId($i),
            ])->all();
    }

    private function projectId(Integration $integration): ?int
    {
        $value = $integration->setting('project_id');

        return $value ? (int) $value : null;
    }

    /**
     * Запись привязок одного вида.
     *
     * Строки, которых нет в присланном списке, не трогаем: человек правит то,
     * что видит в текущем файле, и стирать привязки из прошлых месяцев было бы
     * сюрпризом. Убирает привязку режим auto, и только по конкретной строке.
     */
    private function writeLinks(Integration $integration, string $entity, array $items): void
    {
        $table = fn() => DB::connection($this->dbName)->table('integration_links');

        foreach ($items as $item) {
            $where = [
                'integration_id' => $integration->id,
                'entity'         => $entity,
                'external_id'    => $item['external_id'],
            ];

            if ($item['mode'] === 'auto') {
                $table()->where($where)->delete();
                continue;
            }

            $table()->updateOrInsert($where, [
                'external_name' => $item['external_name'],
                'local_type'    => $item['local_type'],
                'local_id'      => $item['local_id'],
                'synced_at'     => now(),
                'updated_at'    => now(),
                'created_at'    => now(),
            ]);
        }
    }

    /**
     * Проверка целей привязки до записи: существуют ли и не закрыты ли ролью.
     *
     * Счёт, закрытый для этой должности, привязать нельзя — иначе человек
     * настроил бы загрузку туда, куда ему самому смотреть не положено.
     */
    private function checkTargets(array $items, string $table, string $what): ?JsonResponse
    {
        $ids = array_values(array_filter(array_map(
            fn($i) => $i['mode'] === 'bind' ? $i['local_id'] : null, $items
        )));

        if (!$ids) return null;

        if ($table === 'balance_items' && $this->scope->hidesAny($ids)) {
            return $this->hiddenAccountError('соответствии счетов');
        }

        $known = DB::connection($this->dbName)->table($table)
            ->whereIn('id', $ids)->whereNull('deleted_at')->pluck('id')->all();

        foreach ($items as $item) {
            if ($item['mode'] !== 'bind') continue;

            if (!in_array($item['local_id'], $known)) {
                return response()->json([
                    'message' => "Выбранный {$what} для «{$item['external_name']}» больше не существует.",
                ], 422);
            }
        }

        return null;
    }

    /** Сохранённая привязка счетов вместе с названиями счетов FINDIR. */
    private function accountMap(Integration $integration): array
    {
        $rows = DB::connection($this->dbName)
            ->table('integration_links as l')
            ->leftJoin('balance_items as b', function ($join) {
                $join->on('b.id', '=', 'l.local_id')->whereNull('b.deleted_at');
            })
            ->where('l.integration_id', $integration->id)
            ->where('l.entity', PostingsImporter::ENTITY_ACCOUNT)
            ->orderBy('l.external_id')
            ->select('l.external_id as account', 'l.local_id', 'b.code', 'b.name')
            ->get();

        // Закрытые счета не показываем: настройка чужого счёта — такой же
        // способ узнать о нём, как и отчёт
        return $rows->reject(fn($r) => $r->local_id && $this->scope->hides((int) $r->local_id))
            ->map(fn($r) => [
                'account' => $r->account,
                'mode'    => $r->local_id === null ? 'skip' : 'bind',
                'bi_id'   => $r->local_id ? (int) $r->local_id : null,
                'bi'      => $r->code ? $r->code . ' ' . $r->name : null,
            ])->values()->all();
    }

    /**
     * Разобранный файл или готовый ответ об ошибке.
     *
     * Разбор один и тот же для просмотра и загрузки: разойдись они, файл мог бы
     * пройти просмотр и упасть на записи.
     */
    private function readFile(Request $request)
    {
        $request->validate([
            'file' => 'required|file|max:' . self::MAX_FILE_KB,
        ]);

        try {
            return PostingsFile::parse((string) file_get_contents($request->file('file')->getRealPath()));
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    private function summary(IntegrationRun $run): string
    {
        $parts = [
            "получено {$run->fetched}",
            "создано {$run->created}",
            "обновлено {$run->updated}",
            "без изменений {$run->skipped}",
        ];
        if ($run->failed > 0) $parts[] = "пропущено {$run->failed}";

        return implode(', ', $parts);
    }
}
