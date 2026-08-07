<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\TenantBackupService;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Архивная копия данных компании: выгрузка файлом и загрузка обратно.
 *
 * Загрузка заменяет данные целиком, поэтому разделена на два шага: сначала
 * «что внутри файла», и только потом — восстановление с явным подтверждением.
 */
class BackupController extends TenantController
{
    /** Больше — уже не «архивная копия из браузера», а работа для консоли. */
    private const MAX_UPLOAD_MB = 32;

    /**
     * Предел РАЗЖАТОГО файла. Сжатие даёт десятикратный выигрыш, поэтому без
     * такого предела 30-мегабайтный архив развернулся бы в сотни мегабайт и
     * положил бы php на разборе — «zip-бомба» получилась бы и без злого умысла.
     */
    private const MAX_JSON_MB = 96;

    public function __construct(private TenantBackupService $backup) {}

    /** GET /backup/summary — состав будущей копии */
    public function summary(Request $request)
    {
        $this->initTenant($request);

        $counts = $this->backup->counts($this->dbName);

        return response()->json([
            'tenant' => $this->tenantId,
            'counts' => $counts,
            'total'  => array_sum($counts),
        ]);
    }

    /** GET /backup/export — скачать копию */
    public function export(Request $request): StreamedResponse
    {
        $this->initTenant($request);

        $name = 'findir-' . $this->tenantId . '-' . now()->format('Y-m-d-Hi') . '.json.gz';
        $db     = $this->dbName;
        $tenant = $this->tenantId;

        return response()->streamDownload(function () use ($db, $tenant) {
            $this->backup->streamTo($db, $tenant);
        }, $name, [
            'Content-Type'      => 'application/gzip',
            // Размер заранее неизвестен — отдаём потоком, без буферизации в nginx
            'X-Accel-Buffering' => 'no',
        ]);
    }

    /** POST /backup/inspect — что внутри файла, без изменения данных */
    public function inspect(Request $request)
    {
        $this->initTenant($request);
        $payload = $this->readUpload($request);

        try {
            return response()->json($this->backup->inspect($payload));
        } catch (\Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /** POST /backup/import — восстановить (данные заменяются целиком) */
    public function import(Request $request)
    {
        $this->initTenant($request);

        $request->validate(
            ['confirm' => 'required|accepted'],
            ['confirm.required' => 'Восстановление требует подтверждения',
             'confirm.accepted' => 'Восстановление требует подтверждения']
        );
        $payload = $this->readUpload($request);

        try {
            $res = $this->backup->import($this->dbName, $payload);
        } catch (\Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        return response()->json($res + ['ok' => true]);
    }

    /** Разбор загруженного файла с понятными ошибками вместо 500. */
    private function readUpload(Request $request): array
    {
        $request->validate([
            'file' => 'required|file|max:' . (self::MAX_UPLOAD_MB * 1024),
        ], [
            'file.required' => 'Выберите файл архивной копии',
            'file.max'      => 'Файл больше ' . self::MAX_UPLOAD_MB . ' МБ — такую копию грузите из консоли',
        ]);

        $path = $request->file('file')->getRealPath();
        $json = $this->readMaybeGzipped($path);

        // Блокнот и подобные редакторы дописывают BOM в начало — json_decode
        // на нём спотыкается, и пользователь видит «файл не читается» вместо дела
        $json = preg_replace('/^\xEF\xBB\xBF/', '', $json);

        $data = json_decode($json, true);

        if (!is_array($data)) {
            abort(response()->json(['message' => 'Файл не читается как JSON'], 422));
        }

        return $data;
    }

    /**
     * Читает .json.gz и обычный .json.
     *
     * Тип определяем по сигнатуре gzip в первых двух байтах, а не по расширению:
     * файл могли переименовать или скачать без него, и отказ «неверный формат»
     * на рабочем архиве раздражал бы на ровном месте.
     *
     * Разжимаем по кускам с проверкой предела — чтобы маленький архив не мог
     * развернуться в гигабайты и уронить процесс.
     */
    private function readMaybeGzipped(string $path): string
    {
        $fh = fopen($path, 'rb');
        if (!$fh) abort(response()->json(['message' => 'Файл не читается'], 422));

        $head = fread($fh, 2);
        rewind($fh);

        if ($head !== "\x1f\x8b") {          // не gzip — обычный JSON
            $raw = stream_get_contents($fh);
            fclose($fh);
            return (string) $raw;
        }

        $z    = inflate_init(ZLIB_ENCODING_GZIP);
        $out  = '';
        $max  = self::MAX_JSON_MB * 1024 * 1024;

        while (!feof($fh)) {
            $piece = inflate_add($z, (string) fread($fh, 262144));
            if ($piece === false) {
                fclose($fh);
                abort(response()->json(['message' => 'Архив повреждён — не удалось распаковать'], 422));
            }
            $out .= $piece;

            if (strlen($out) > $max) {
                fclose($fh);
                abort(response()->json([
                    'message' => 'Внутри архива больше ' . self::MAX_JSON_MB . ' МБ данных — восстанавливайте из консоли',
                ], 422));
            }
        }
        fclose($fh);

        // Обрыв закачки даёт «частично валидный» gzip: он распаковывается без
        // ошибки, но обрывается на середине JSON. Без этой проверки пользователь
        // увидел бы «файл не читается» и полез бы искать проблему не там.
        if (inflate_get_status($z) !== ZLIB_STREAM_END) {
            abort(response()->json([
                'message' => 'Архив обрывается на середине — скорее всего, файл скачался не полностью',
            ], 422));
        }

        return $out;
    }
}
