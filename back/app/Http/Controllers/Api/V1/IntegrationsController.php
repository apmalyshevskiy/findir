<?php

namespace App\Http\Controllers\Api\V1;

use App\Models\Tenant\Integration;
use App\Models\Tenant\IntegrationRun;
use App\Services\Integrations\IntegrationRegistry;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * Интеграции с учётными системами.
 *
 * Контроллер намеренно не знает ни про FusionPOS, ни про накладные: тип
 * разбирает реестр, работу делает драйвер. Новая система не должна приводить
 * сюда с правками.
 */
class IntegrationsController extends TenantController
{
    /**
     * Предел периода одной загрузки. Загрузка идёт синхронно, а у php и nginx
     * свои таймауты — на годовом периоде запрос оборвался бы на середине, и
     * человек не понял бы, загрузилось что-то или нет.
     */
    private const MAX_DAYS = 92;

    // ─── Схема типов ─────────────────────────────────────────────────

    /** GET /integrations/types — по этой схеме фронт собирает форму настроек */
    public function types(Request $request): JsonResponse
    {
        $this->initTenant($request);

        return response()->json(['data' => IntegrationRegistry::types()]);
    }

    // ─── CRUD ────────────────────────────────────────────────────────

    public function index(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $items = Integration::on($this->dbName)->orderBy('name')->get();

        return response()->json(['data' => $items->map(fn($i) => $this->format($i))]);
    }

    public function show(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $integration = Integration::on($this->dbName)->findOrFail($id);

        return response()->json(['data' => $this->format($integration)]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->initTenant($request);

        $data = $request->validate([
            'type'        => 'required|string|max:40',
            'name'        => 'required|string|max:255',
            'is_active'   => 'boolean',
            'settings'    => 'array',
            'credentials' => 'array',
        ]);

        IntegrationRegistry::schema($data['type']);   // упадёт на неизвестном типе

        $integration = (new Integration)->setConnection($this->dbName);
        $integration->fill([
            'type'      => $data['type'],
            'name'      => $data['name'],
            'is_active' => $data['is_active'] ?? true,
            'settings'  => array_merge(IntegrationRegistry::defaults($data['type']), $data['settings'] ?? []),
        ]);
        $integration->setCredentials(
            IntegrationRegistry::driver($data['type'])->normalizeCredentials($data['credentials'] ?? [])
        );
        $integration->save();

        return response()->json(['data' => $this->format($integration)], 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $integration = Integration::on($this->dbName)->findOrFail($id);

        $data = $request->validate([
            'name'        => 'string|max:255',
            'is_active'   => 'boolean',
            'settings'    => 'array',
            'credentials' => 'array',
        ]);

        if (isset($data['name']))      $integration->name      = $data['name'];
        if (isset($data['is_active'])) $integration->is_active = $data['is_active'];

        // Умолчания подмешиваем и при обновлении: не присланное поле должно
        // вернуться к значению по умолчанию, а не обнулиться. Явно переданное
        // значение (в том числе false у галочек) всегда сильнее умолчания
        if (isset($data['settings'])) {
            $integration->settings = array_merge(
                IntegrationRegistry::defaults($integration->type),
                $data['settings']
            );
        }

        // Пустое значение поля доступа означает «не меняли»: наружу токен не
        // отдаётся, и форма присылает его пустым, пока человек не введёт новый
        if (isset($data['credentials'])) {
            $current = $integration->credentials();
            foreach ($data['credentials'] as $key => $value) {
                if ($value === '' || $value === null) continue;
                $current[$key] = $value;
            }
            $integration->setCredentials(
                IntegrationRegistry::driver($integration)->normalizeCredentials($current)
            );
        }

        $integration->save();

        return response()->json(['data' => $this->format($integration)]);
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        Integration::on($this->dbName)->findOrFail($id)->delete();

        return response()->json(['ok' => true]);
    }

    // ─── Связь и справочники источника ───────────────────────────────

    /** POST /integrations/{id}/test */
    public function test(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $integration = Integration::on($this->dbName)->findOrFail($id);

        try {
            $message = IntegrationRegistry::driver($integration)->testConnection($integration);
        } catch (\Throwable $e) {
            return response()->json(['ok' => false, 'message' => $e->getMessage()], 422);
        }

        return response()->json(['ok' => true, 'message' => $message]);
    }

    /** GET /integrations/{id}/dictionaries — склады, юрлица и прочее для настроек */
    public function dictionaries(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $integration = Integration::on($this->dbName)->findOrFail($id);

        try {
            return response()->json(['data' => IntegrationRegistry::driver($integration)->dictionaries($integration)]);
        } catch (\Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    // ─── Загрузка ────────────────────────────────────────────────────

    /**
     * POST /integrations/{id}/preview — что лежит в источнике за период.
     *
     * Шаг перед загрузкой: ничего не пишем, только показываем список с
     * пометками. Так человек видит, что именно изменится, до того как это
     * попадёт в учёт.
     */
    public function preview(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $integration = Integration::on($this->dbName)->findOrFail($id);

        $data = $request->validate([
            'entity' => 'required|string|max:40',
            'from'   => 'required|date',
            'to'     => 'required|date|after_or_equal:from',
        ]);

        if ($resp = $this->periodError($data['from'], $data['to'])) return $resp;

        @set_time_limit(300);

        try {
            $rows = IntegrationRegistry::driver($integration)
                ->preview($integration, $data['entity'], Carbon::parse($data['from'])->toDateString(), Carbon::parse($data['to'])->toDateString());
        } catch (\Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        $counts = array_count_values(array_column($rows, 'status'));

        return response()->json([
            'data'   => $rows,
            'counts' => $counts,
            'total'  => count($rows),
        ]);
    }

    /** POST /integrations/{id}/object — что внутри одного объекта источника */
    public function object(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $integration = Integration::on($this->dbName)->findOrFail($id);

        $data = $request->validate([
            'entity'      => 'required|string|max:40',
            'external_id' => 'required|string|max:191',
        ]);

        try {
            $detail = IntegrationRegistry::driver($integration)
                ->object($integration, $data['entity'], $data['external_id']);
        } catch (\Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        return response()->json(['data' => $detail]);
    }

    /** POST /integrations/{id}/sync */
    public function sync(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        $integration = Integration::on($this->dbName)->findOrFail($id);

        $data = $request->validate([
            'entity' => 'required|string|max:40',
            'from'   => 'required|date',
            'to'     => 'required|date|after_or_equal:from',
            'ids'    => 'sometimes|array',
            'ids.*'  => 'string|max:191',
        ]);

        if ($resp = $this->periodError($data['from'], $data['to'])) return $resp;

        $from = Carbon::parse($data['from'])->toDateString();
        $to   = Carbon::parse($data['to'])->toDateString();

        // Пустой список отмеченных — это «не выбрано ничего», а не «взять всё»:
        // молча загрузить весь период вместо ничего было бы худшим ответом
        if (array_key_exists('ids', $data) && count($data['ids']) === 0) {
            return response()->json(['message' => 'Не отмечено ни одной накладной'], 422);
        }
        $only = $data['ids'] ?? null;

        $driver = IntegrationRegistry::driver($integration);

        if (!array_key_exists($data['entity'], $driver->entities())) {
            return response()->json(['message' => 'Эта интеграция не умеет загружать такие данные'], 422);
        }

        $run = (new IntegrationRun)->setConnection($this->dbName);
        $run->fill([
            'integration_id' => $integration->id,
            'entity'         => $data['entity'],
            'mode'           => 'manual',
            'period_from'    => $from,
            'period_to'      => $to,
            'status'         => 'running',
            'started_at'     => now(),
            // Явные нули, а не значения по умолчанию из схемы: модель после
            // save() не перечитывается, и в отчёте о пустой загрузке вместо
            // «получено 0» получилось бы «получено »
            'fetched' => 0, 'created' => 0, 'updated' => 0, 'skipped' => 0, 'failed' => 0,
        ]);
        $run->save();

        @set_time_limit(300);

        try {
            $driver->sync($integration, $run, $from, $to, $only);
            // Часть накладных могла не пройти (закрытый период, кривые данные) —
            // это не провал загрузки, но и не «всё хорошо»
            $run->status  = $run->failed > 0 ? 'warning' : 'ok';
            $run->message = $this->summary($run);
        } catch (\Throwable $e) {
            $run->status  = 'error';
            $run->message = $e->getMessage();
        }

        $run->finished_at = now();
        $run->save();

        $integration->last_run_at      = $run->finished_at;
        $integration->last_run_status  = $run->status;
        $integration->last_run_message = $run->message;
        $integration->save();

        return response()->json([
            'ok'   => $run->status !== 'error',
            'data' => $run->fresh(),
        ], $run->status === 'error' ? 422 : 200);
    }

    /** GET /integrations/{id}/runs — журнал загрузок */
    public function runs(Request $request, int $id): JsonResponse
    {
        $this->initTenant($request);

        Integration::on($this->dbName)->findOrFail($id);

        $runs = IntegrationRun::on($this->dbName)
            ->where('integration_id', $id)
            ->orderByDesc('id')
            ->limit((int) ($request->limit ?? 20))
            ->get();

        return response()->json(['data' => $runs]);
    }

    // ─── Вспомогательное ─────────────────────────────────────────────

    /**
     * Секретами считаем только поля-пароли. Домен и логин прятать не от кого,
     * а спрятанный домен вреден: поле открывалось пустым, человек не видел
     * сохранённого значения и проверял связь не с тем, что на экране.
     */
    private function publicCredentials(Integration $integration): array
    {
        $secret = [];
        foreach (IntegrationRegistry::schema($integration->type)['credentials'] as $field) {
            if (($field['kind'] ?? 'text') === 'password') $secret[] = $field['key'];
        }

        return array_diff_key($integration->credentials(), array_flip($secret));
    }

    /**
     * Чего не хватает, чтобы запускать загрузку.
     *
     * Считаем заранее и показываем на экране загрузки: иначе человек жмёт
     * «Загрузить» и получает отказ на середине — а причина всё это время
     * лежала в настройках.
     *
     * @return array<int, string> человеческие названия незаполненного
     */
    private function missingSetup(Integration $integration): array
    {
        $schema  = IntegrationRegistry::schema($integration->type);
        $creds   = $integration->credentials();
        $missing = [];

        foreach ($schema['credentials'] as $f) {
            if (($f['required'] ?? false) && empty($creds[$f['key']])) {
                $missing[] = mb_strtolower($f['label']);
            }
        }
        foreach ($schema['settings'] as $f) {
            if (($f['required'] ?? false) && !$integration->setting($f['key'])) {
                $missing[] = mb_strtolower($f['label']);
            }
        }

        return $missing;
    }

    private function format(Integration $integration): array
    {
        return [
            'id'               => $integration->id,
            'type'             => $integration->type,
            'name'             => $integration->name,
            'is_active'        => $integration->is_active,
            'settings'         => $integration->settings ?: [],
            'credentials'      => $this->publicCredentials($integration),
            // Сам токен не отдаём никогда — только признак, что он задан
            'has_credentials'  => $integration->hasCredentials(),
            'entities'         => IntegrationRegistry::driver($integration)->entities(),
            'missing'          => $missing = $this->missingSetup($integration),
            'is_ready'         => empty($missing),
            'last_run_at'      => $integration->last_run_at,
            'last_run_status'  => $integration->last_run_status,
            'last_run_message' => $integration->last_run_message,
        ];
    }

    /** Общий для просмотра и загрузки предел периода. */
    private function periodError(string $from, string $to): ?JsonResponse
    {
        if (Carbon::parse($from)->diffInDays(Carbon::parse($to)) > self::MAX_DAYS) {
            return response()->json([
                'message' => 'Период больше ' . self::MAX_DAYS . ' дней — берите частями, иначе запрос оборвётся по таймауту',
            ], 422);
        }
        return null;
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
