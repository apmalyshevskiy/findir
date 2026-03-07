<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\ClientBankExchangeParser;
use App\Services\BankStatementMatcher;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class BankStatementController extends TenantController
{
    /**
     * POST /bank-statements/parse
     *
     * Принимает TXT-файл (1C ClientBankExchange).
     * Парсит, автосопоставляет, проверяет дубли.
     * Ничего не сохраняет в БД — возвращает данные для формы.
     */
    public function parse(Request $request)
    {
        $this->initTenant($request);

        $request->validate([
            'file' => 'required|file|mimes:txt,text|max:10240', // max 10MB
        ]);

        // ── Парсинг ────────────────────────────────────────────────────────
        $parser  = new ClientBankExchangeParser();
        $content = file_get_contents($request->file('file')->getRealPath());
        $parsed  = $parser->parseFile($content);

        $header = $parsed['header'];
        $rows   = $parsed['rows'];

        // ── Автосопоставление ─────────────────────────────────────────────
        $matcher = new BankStatementMatcher($this->dbName);
        $rows    = $matcher->matchRows($rows, $header['account_number'] ?? '');

        // ── Поиск дублей ──────────────────────────────────────────────────
        $existingMap = $matcher->findExistingOperations($rows);

        // Добавляем existing_operation_ids к каждой строке
        foreach ($rows as &$row) {
            $key = ($row['external_id'] ?? '') . '|' . ($row['external_date'] ?? '');
            $row['existing_operation_ids'] = $existingMap[$key] ?? [];
        }
        unset($row);

        // ── Автопоиск расчётного счёта в info ────────────────────────────
        $cashInfoId = $this->findCashInfo($header['account_number'] ?? null);

        // ── Загружаем список проектов для шапки формы ─────────────────────
        $projects = DB::connection($this->dbName)
            ->table('projects')
            ->whereNull('deleted_at')
            ->orderBy('name')
            ->select('id', 'name')
            ->get();

        return response()->json([
            'header'       => $header,
            'cash_info_id' => $cashInfoId,
            'projects'     => $projects,
            'rows'         => $rows,
            'stats'        => [
                'total'    => count($rows),
                'matched'  => count(array_filter($rows, fn($r) => !empty($r['suggested_flow_id']) && !empty($r['suggested_partner_id']))),
                'existing' => count(array_filter($rows, fn($r) => !empty($r['existing_operation_ids']))),
            ],
        ]);
    }

    // ── Приватные ────────────────────────────────────────────────────────────

    /**
     * Ищем info.type=cash по номеру счёта.
     * Сначала в поле description (формат "…40702810003000109561…"),
     * затем в поле code.
     */
    private function findCashInfo(?string $accountNumber): ?int
    {
        if (!$accountNumber) return null;

        $accountNumber = trim($accountNumber);

        $found = DB::connection($this->dbName)
            ->table('info')
            ->where('type', 'cash')
            ->where('is_active', true)
            ->whereNull('deleted_at')
            ->where(function ($q) use ($accountNumber) {
                $q->where('description', 'LIKE', "%{$accountNumber}%")
                  ->orWhere('code', $accountNumber);
            })
            ->select('id')
            ->first();

        return $found ? (int) $found->id : null;
    }
}
