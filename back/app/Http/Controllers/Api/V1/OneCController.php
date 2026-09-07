<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\OneC\PostingsFile;
use App\Services\OneC\PostingsImporter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Загрузка проводок из 1С:Бухгалтерии.
 *
 * Файл выгружает обработка из папки 1c/ в корне репозитория; формат описан в
 * 1c/FORMAT.md. Сюда он попадает через форму — по сети 1С к нам не ходит.
 *
 * Загрузка в два шага: сначала просмотр (ничего не пишется), потом отмеченные
 * проводки. Одной кнопкой «взять всё» пользоваться страшно — из файла за месяц
 * получаются сотни операций, и увидеть их до записи важнее, чем сэкономить щелчок.
 */
class OneCController extends TenantController
{
    /** Ключ проекта в settings: проводки 1С проекта не знают, его выбирают у нас. */
    private const PROJECT_KEY = 'onec_project_id';

    /** Файл за месяц — сотни килобайт; 20 МБ хватает с запасом на год. */
    private const MAX_FILE_KB = 20480;

    /**
     * GET /onec/settings
     *
     * Проект и сохранённое соответствие счетов. Счета отдаём вместе с кодом и
     * названием: список нужен и для показа, и для выпадающего списка.
     */
    public function settings(Request $request)
    {
        $this->initTenant($request);

        return response()->json([
            'data' => [
                'project_id' => $this->projectId(),
                'accounts'   => $this->accountMap(),
                'projects'   => DB::connection($this->dbName)->table('projects')
                    ->whereNull('deleted_at')->orderBy('name')->select('id', 'name')->get(),
            ],
        ]);
    }

    /**
     * PUT /onec/settings
     *
     * Соответствие приходит целиком: пустой bi_id означает «убрать строку».
     * Частичное обновление здесь только запутало бы — таблица маленькая и
     * правится вся сразу.
     */
    public function saveSettings(Request $request)
    {
        $this->initTenant($request);

        $data = $request->validate([
            'project_id'          => 'nullable|integer',
            'accounts'            => 'array',
            'accounts.*.account'  => 'required|string|max:20',
            'accounts.*.bi_id'    => 'nullable|integer',
        ]);

        // Список пар, а не карта «счёт → id». Ключом массива код счёта быть не
        // может: PHP приводит числовые ключи к integer, и счета вроде «26» и
        // «51» уехали бы числами. MySQL на сравнении varchar с числом приводит
        // к числу саму колонку, и отбор поехал бы молча
        $wanted = [];
        foreach ($data['accounts'] ?? [] as $row) {
            $account = trim((string) $row['account']);
            if ($account === '' || empty($row['bi_id'])) continue;
            $wanted[] = ['account' => $account, 'bi_id' => (int) $row['bi_id']];
        }

        $codes = array_column($wanted, 'account');
        $biIds = array_column($wanted, 'bi_id');

        // Счёт, закрытый для этой должности, сопоставить нельзя: иначе человек
        // настроил бы загрузку туда, куда ему самому смотреть не положено
        if ($biIds && $this->scope->hidesAny($biIds)) {
            return $this->hiddenAccountError('соответствии счетов');
        }

        $known = DB::connection($this->dbName)->table('balance_items')
            ->whereIn('id', $biIds ?: [0])->whereNull('deleted_at')->pluck('id')->all();

        foreach ($wanted as $row) {
            if (!in_array($row['bi_id'], $known)) {
                return response()->json([
                    'message' => "Счёта FINDIR для «{$row['account']}» больше нет в плане счетов.",
                ], 422);
            }
        }

        DB::connection($this->dbName)->transaction(function () use ($wanted, $codes, $data) {
            $conn = DB::connection($this->dbName);

            // Каждому запросу — свой построитель. Построитель накапливает
            // условия, и один объект на всё дописал бы к updateOrInsert ещё и
            // whereNotIn от удаления: строка не находилась бы, вставка падала
            // на уникальном индексе
            $conn->table('onec_account_map')->whereNotIn('account', $codes ?: [''])->delete();

            foreach ($wanted as $row) {
                $conn->table('onec_account_map')->updateOrInsert(
                    ['account' => $row['account']],
                    ['bi_id' => $row['bi_id'], 'updated_at' => now(), 'created_at' => now()],
                );
            }

            if (array_key_exists('project_id', $data)) {
                $conn->table('settings')->updateOrInsert(
                    ['key' => self::PROJECT_KEY],
                    ['value' => $data['project_id'], 'updated_at' => now(), 'created_at' => now()],
                );
            }
        });

        return response()->json(['data' => [
            'project_id' => $this->projectId(),
            'accounts'   => $this->accountMap(),
        ]]);
    }

    /**
     * POST /onec/postings/preview
     *
     * Разбирает файл и показывает, что из него получится. В базу не пишет.
     */
    public function preview(Request $request)
    {
        $this->initTenant($request);

        $file = $this->readFile($request);
        if (!is_array($file)) return $file;

        $importer = new PostingsImporter(
            $this->dbName, $this->scope, $this->editLockDate(), $this->projectId(),
        );

        $result = $importer->preview($file);

        return response()->json([
            'data' => $result + [
                'meta'       => $file['meta'],
                'problems'   => $file['problems'],
                'project_id' => $this->projectId(),
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

        $file = $this->readFile($request);
        if (!is_array($file)) return $file;

        $projectId = $this->projectId();
        if (!$projectId) {
            return response()->json([
                'message' => 'Не выбран проект. Проводки 1С проекта не знают — его нужно указать до загрузки.',
            ], 422);
        }

        $importer = new PostingsImporter(
            $this->dbName, $this->scope, $this->editLockDate(), $projectId,
        );

        $only   = $request->input('only');
        $result = $importer->import($file, is_array($only) ? $only : null);

        return response()->json(['data' => $result]);
    }

    // ─── Приватные ───────────────────────────────────────────────────────────

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

    private function projectId(): ?int
    {
        $value = DB::connection($this->dbName)->table('settings')
            ->where('key', self::PROJECT_KEY)->value('value');

        return $value ? (int) $value : null;
    }

    /** Сохранённое соответствие вместе с названиями счетов FINDIR. */
    private function accountMap(): array
    {
        $rows = DB::connection($this->dbName)
            ->table('onec_account_map as m')
            ->join('balance_items as b', 'b.id', '=', 'm.bi_id')
            ->whereNull('b.deleted_at')
            ->orderBy('m.account')
            ->select('m.account', 'b.id as bi_id', 'b.code', 'b.name')
            ->get();

        // Закрытые счета не показываем и не отдаём: настройка чужого счёта —
        // такой же способ узнать о нём, как и отчёт
        return $rows->reject(fn($r) => $this->scope->hides((int) $r->bi_id))
            ->map(fn($r) => [
                'account' => $r->account,
                'bi_id'   => (int) $r->bi_id,
                'bi'      => $r->code . ' ' . $r->name,
            ])->values()->all();
    }
}
