<?php

namespace App\Services;

/**
 * Парсер формата 1C ClientBankExchange v1.03
 * Кодировка файла: Windows-1251
 */
class ClientBankExchangeParser
{
    /**
     * Правила извлечения суммы комиссии из назначения для «свёрнутого»
     * эквайринга (банк удержал комиссию ДО зачисления, отдельной строки в
     * выписке нет — только текст). Срабатывание правила = признак свода:
     * такую строку нужно развернуть в 2 операции (приход нетто + комиссия).
     *
     * Правила приходят извне (из settings.acquiring_fee_rules), а не зашиты
     * в код — добавление банка не требует деплоя. Источник правды и дефолты —
     * App\Services\Acquiring\AcquiringFeeRules.
     *
     * Каждое правило: ['bank' => 'tbank|alfa|sber', 'marker' => '...',
     *                  'amount_format' => 'rub_kop'|'dot', 'is_active' => bool].
     * Сырой regex здесь НЕ хранится и НЕ принимается — он собирается из
     * marker + amount_format (matchFeeByRule), поэтому всегда валиден.
     *
     * @var array<int, array>
     */
    private array $feeRules = [];

    /**
     * Банк, определённый по заголовку (Отправитель), для скоупа правил
     * комиссии. Null = банк не опознан → пробуем все активные правила.
     */
    private ?string $bank = null;

    /**
     * @param array $feeRules Правила свода из settings (через AcquiringFeeRules::load()).
     *                        Пустой массив = свод не выполняется (безопасная деградация).
     */
    public function __construct(array $feeRules = [])
    {
        $this->feeRules = $feeRules;
    }

    /**
     * Распарсить содержимое файла (строка в UTF-8 после декодирования).
     *
     * @return array{header: array, rows: array}
     */
    public function parse(string $content): array
    {
        $this->bank = null; // сбрасываем на каждый файл

        // Нормализуем переносы строк
        $content = str_replace("\r\n", "\n", $content);
        $content = str_replace("\r", "\n", $content);

        $lines = explode("\n", $content);

        $header  = [];
        $section = null; // 'header' | 'account' | 'document'
        $current = [];
        $rows    = [];

        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') continue;

            // ── Маркеры секций ───────────────────────────────────────────────
            if ($line === '1CClientBankExchange') {
                $section = 'header';
                continue;
            }

            if ($line === 'СекцияРасчСчет') {
                $section = 'account';
                continue;
            }

            if ($line === 'КонецРасчСчет') {
                $section = 'header'; // возвращаемся, дальше могут идти документы
                continue;
            }

            if (str_starts_with($line, 'СекцияДокумент=')) {
                // Сохраняем предыдущий документ если есть
                if ($section === 'document' && !empty($current)) {
                    $rows[] = $this->buildRow($current);
                }
                $current = ['_doc_type' => trim(substr($line, strpos($line, '=') + 1))];
                $section = 'document';
                continue;
            }

            if ($line === 'КонецДокумента') {
                if ($section === 'document' && !empty($current)) {
                    $rows[] = $this->buildRow($current);
                }
                $current = [];
                $section = 'header';
                continue;
            }

            if ($line === 'КонецФайла') {
                break;
            }

            // ── Разбор пар ключ=значение ─────────────────────────────────────
            $eqPos = strpos($line, '=');
            if ($eqPos === false) continue;

            $key   = trim(substr($line, 0, $eqPos));
            $value = trim(substr($line, $eqPos + 1));

            if ($section === 'header' || $section === 'account') {
                $header[$key] = $value;
                // Отправитель идёт в шапке до документов → к моменту разбора
                // строк банк уже определён и доступен в extractAcquiringFee().
                if ($key === 'Отправитель') {
                    $this->bank = $this->detectBank($value);
                }
            } elseif ($section === 'document') {
                $current[$key] = $value;
            }
        }

        return [
            'header' => $this->buildHeader($header),
            'rows'   => $rows,
        ];
    }

    /**
     * Принять файл как binary string, декодировать из Win-1251 и распарсить.
     */
    public function parseFile(string $binaryContent): array
    {
        $utf8 = mb_convert_encoding($binaryContent, 'UTF-8', 'Windows-1251');
        return $this->parse($utf8);
    }

    // ── Приватные методы ──────────────────────────────────────────────────────

    private function buildHeader(array $h): array
    {
        return [
            'bank_name'       => $h['Отправитель']       ?? null,
            'account_number'  => $h['РасчСчет']          ?? null,
            'date_from'       => $this->parseDate($h['ДатаНачала'] ?? null),
            'date_to'         => $this->parseDate($h['ДатаКонца']  ?? null),
            'opening_balance' => $this->parseAmount($h['НачальныйОстаток'] ?? null),
            'closing_balance' => $this->parseAmount($h['КонечныйОстаток']  ?? null),
            'total_in'        => $this->parseAmount($h['ВсегоПоступило']   ?? null),
            'total_out'       => $this->parseAmount($h['ВсегоСписано']     ?? null),
        ];
    }

    private function buildRow(array $d): array
    {
        $amount    = $this->parseAmount($d['Сумма'] ?? null);
        $direction = $this->resolveDirection($d);
        $docDate   = $this->parseDate($d['Дата'] ?? null);
        $docNumber = $d['Номер'] ?? null;

        // Контрагент: при приходе — плательщик, при расходе — получатель.
        // Имя: сначала поле с цифрой (Т-Банк: Плательщик1/Получатель1), затем
        // без цифры (Альфа: Плательщик/Получатель). Так покрываем оба формата.
        if ($direction === 'in') {
            $counterpartyName = $d['Плательщик1']    ?? $d['Плательщик'] ?? null;
            $counterpartyInn  = $d['ПлательщикИНН']  ?? null;
            $counterpartyAcc  = $d['ПлательщикСчет'] ?? null;
        } else {
            $counterpartyName = $d['Получатель1']    ?? $d['Получатель'] ?? null;
            $counterpartyInn  = $d['ПолучательИНН']  ?? null;
            $counterpartyAcc  = $d['ПолучательСчет'] ?? null;
        }

        // Альфа дописывает в имя хвост " Р/С <счёт>" — срезаем (ИНН берём из
        // отдельного поля, в имени он не нужен).
        if ($counterpartyName !== null) {
            $counterpartyName = preg_replace('/\s+Р\/С\s+\d.*$/u', '', $counterpartyName);
        }

        // Перевод между своими счетами: ИНН плательщика == ИНН получателя в самом документе.
        // Самодостаточный сигнал — внешние реквизиты организации не нужны.
        $payerInn = isset($d['ПлательщикИНН']) ? trim($d['ПлательщикИНН']) : '';
        $payeeInn = isset($d['ПолучательИНН']) ? trim($d['ПолучательИНН']) : '';
        $isSelfTransfer = $payerInn !== '' && $payerInn === $payeeInn;

        $purpose = $d['НазначениеПлатежа'] ?? null;

        // Эквайринг-свод: пытаемся извлечь удержанную комиссию из назначения.
        // Срабатывание = признак свода (строку развернём в 2 операции на фронте).
        // Только приход: банк зачисляет нетто, комиссия в тексте.
        $acquiring = $this->extractAcquiringFee($purpose, $direction);

        return [
            'doc_type'         => $d['_doc_type']     ?? null,
            'doc_number'       => $docNumber,
            'doc_date'         => $docDate,
            'amount'           => $amount,
            'direction'        => $direction,
            'counterparty_raw' => $counterpartyName ? trim($counterpartyName) : null,
            'counterparty_inn' => $counterpartyInn   ? trim($counterpartyInn) : null,
            'counterparty_account' => $counterpartyAcc ? trim($counterpartyAcc) : null,
            'is_self_transfer' => $isSelfTransfer,
            'purpose_raw'      => $purpose ? trim($purpose) : null,
            // Эквайринг-свод (только при срабатывании паттерна комиссии)
            'is_acquiring_split' => $acquiring !== null,
            'acquiring_fee'      => $acquiring['fee']  ?? null,
            'acquiring_bank'     => $acquiring['bank'] ?? null,
            // Поля для записи в операцию
            'external_id'      => $docNumber ? (string) $docNumber : null,
            'external_date'    => $docDate,
            // note формируется: [Номер от Дата] Контрагент, ИНН …, р/с …
            // Назначение платежа сюда не идёт — оно уходит в content операции
            'note'             => $this->buildNote(
                $docNumber,
                $docDate,
                $counterpartyName,
                $counterpartyInn,
                $counterpartyAcc,
            ),
        ];
    }

    /**
     * Извлечь сумму удержанной комиссии из назначения эквайринг-свода.
     * Возвращает ['fee' => float, 'bank' => string] или null, если ни один
     * паттерн не совпал (значит это не свод).
     */
    private function extractAcquiringFee(?string $purpose, string $direction = 'in'): ?array
    {
        // Свод бывает только в приходе (банк зачислил нетто, комиссию удержал).
        // Расходные строки («Комиссия к возм», банк-услуги) сюда не попадают.
        if ($direction !== 'in') {
            return null;
        }

        if ($purpose === null || trim($purpose) === '') {
            return null;
        }

        foreach ($this->feeRules as $rule) {
            // Выключенные правила пропускаем.
            if (array_key_exists('is_active', $rule) && !$rule['is_active']) {
                continue;
            }
            $bank = $rule['bank'] ?? null;
            // Банк опознан по Отправителю → применяем только его правила.
            // Не опознан ($this->bank === null) → пробуем все активные.
            if ($this->bank !== null && $bank !== $this->bank) {
                continue;
            }
            $fee = $this->matchFeeByRule($rule, $purpose);
            if ($fee !== null && $fee > 0) {
                return ['fee' => round($fee, 2), 'bank' => $bank];
            }
        }

        return null;
    }

    /**
     * Извлечь сумму комиссии по одному правилу. Regex собирается из marker +
     * amount_format (сырой regex наружу не выставляется), поэтому всегда валиден.
     *
     * Форматы:
     *   rub_kop — "<маркер> 2534 руб. 77 коп."  (Тбанк)
     *   dot     — "<маркер> 1 511.16"           (Альфа: "К.", Сбер: "Комиссия")
     *             допускает пробелы-тысячи внутри числа; сумму берём СРАЗУ
     *             после маркера, чтобы не перехватить НДС из хвоста строки.
     */
    private function matchFeeByRule(array $rule, string $purpose): ?float
    {
        $marker = trim((string) ($rule['marker'] ?? ''));
        $format = (string) ($rule['amount_format'] ?? '');
        if ($marker === '') {
            return null;
        }

        $m = preg_quote($marker, '/');

        if ($format === 'rub_kop') {
            $regex = '/' . $m . '\s*(\d+)\s*руб\.?\s*(\d+)\s*коп/iu';
            if (@preg_match($regex, $purpose, $x) === 1) {
                return (int) $x[1] + (int) $x[2] / 100;
            }
            return null;
        }

        if ($format === 'dot') {
            // ([\d \x{00A0}]+) — рубли с возможными пробелами-тысячами;
            // (?!\d) — копейки не «прилипают» к более длинному числу.
            $regex = '/' . $m . '\s*([\d \x{00A0}]+)\.(\d{2})(?!\d)/u';
            if (@preg_match($regex, $purpose, $x) === 1) {
                $rub = (int) preg_replace('/\D/', '', $x[1]); // вычищаем пробелы
                return $rub + (int) $x[2] / 100;
            }
            return null;
        }

        // Неизвестный формат — игнорируем (валидация на записи это не пропустит).
        return null;
    }

    /**
     * Опознать банк по полю Отправитель из шапки файла. Используется для скоупа
     * паттернов комиссии. Возвращает метку банка или null (не опознан).
     */
    private function detectBank(?string $sender): ?string
    {
        $s = mb_strtolower(trim((string) $sender));
        if ($s === '') {
            return null;
        }
        // Схлопываем разделители: "т-банк"/"альфа-бизнес онлайн" → "тбанк"/"альфабизнесонлайн"
        $c = str_replace([' ', '-', '"', '«', '»'], '', $s);
        if (mb_strpos($c, 'альфа') !== false || mb_strpos($c, 'alfa') !== false) {
            return 'alfa';
        }
        if (mb_strpos($c, 'тбанк')  !== false || mb_strpos($c, 'тинько') !== false
            || mb_strpos($c, 'tbank') !== false) {
            return 'tbank';
        }
        if (mb_strpos($c, 'сбер') !== false || mb_strpos($c, 'sber') !== false) {
            return 'sber';
        }
        return null;
    }

    private function resolveDirection(array $d): string
    {
        // Приход: есть ДатаПоступило
        if (!empty($d['ДатаПоступило'])) {
            return 'in';
        }
        // Расход: есть ДатаСписано
        if (!empty($d['ДатаСписано'])) {
            return 'out';
        }
        // Fallback: если наш счёт совпадает с ПолучательСчет — приход
        // (этот случай не должен встречаться в корректных файлах)
        return 'out';
    }

    /**
     * Примечание к операции: реквизиты платёжки и контрагента.
     *
     * Назначение платежа сюда намеренно не попадает — оно уходит в content
     * операции, и дублировать его в примечании значило бы хранить одно и то же
     * дважды. В примечании остаётся то, чего в content нет: номер и дата
     * документа, контрагент, его ИНН и расчётный счёт — по ним потом сверяют
     * платёж с банком и находят операцию поиском.
     */
    private function buildNote(
        ?string $number,
        ?string $date,
        ?string $name,
        ?string $inn,
        ?string $account,
    ): ?string {
        $parts = [];

        if ($number || $date) {
            $prefix = '[';
            if ($number) $prefix .= $number;
            if ($number && $date) $prefix .= ' от ';
            if ($date) $prefix .= $date;
            $prefix .= ']';
            $parts[] = $prefix;
        }

        // Контрагент и его реквизиты — через запятую, пустые опускаем
        $who = [];
        if ($name    && trim($name) !== '')    $who[] = trim($name);
        if ($inn     && trim($inn) !== '')     $who[] = 'ИНН ' . trim($inn);
        if ($account && trim($account) !== '') $who[] = 'р/с ' . trim($account);
        if ($who) $parts[] = implode(', ', $who);

        return $parts ? implode(' ', $parts) : null;
    }

    /**
     * DD.MM.YYYY → YYYY-MM-DD
     */
    private function parseDate(?string $value): ?string
    {
        if (!$value) return null;
        $value = trim($value);
        if (preg_match('/^(\d{2})\.(\d{2})\.(\d{4})$/', $value, $m)) {
            return "{$m[3]}-{$m[2]}-{$m[1]}";
        }
        return null;
    }

    /**
     * "1 157 025,50" или "1157025.50" → float
     */
    private function parseAmount(?string $value): ?float
    {
        if ($value === null || $value === '') return null;
        // Убираем пробелы (разделитель тысяч)
        $value = str_replace([' ', "\u{00A0}"], '', $value);
        // Заменяем запятую на точку
        $value = str_replace(',', '.', $value);
        return is_numeric($value) ? (float) $value : null;
    }
}
