<?php

namespace App\Services;

/**
 * Парсер формата 1C ClientBankExchange v1.03
 * Кодировка файла: Windows-1251
 */
class ClientBankExchangeParser
{
    /**
     * Распарсить содержимое файла (строка в UTF-8 после декодирования).
     *
     * @return array{header: array, rows: array}
     */
    public function parse(string $content): array
    {
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

        // Контрагент: при приходе — плательщик, при расходе — получатель
        if ($direction === 'in') {
            $counterpartyName = $d['Плательщик1']    ?? null;
            $counterpartyInn  = $d['ПлательщикИНН']  ?? null;
            $counterpartyAcc  = $d['ПлательщикСчет'] ?? null;
        } else {
            $counterpartyName = $d['Получатель1']    ?? null;
            $counterpartyInn  = $d['ПолучательИНН']  ?? null;
            $counterpartyAcc  = $d['ПолучательСчет'] ?? null;
        }

        $purpose = $d['НазначениеПлатежа'] ?? null;

        return [
            'doc_type'         => $d['_doc_type']     ?? null,
            'doc_number'       => $docNumber,
            'doc_date'         => $docDate,
            'amount'           => $amount,
            'direction'        => $direction,
            'counterparty_raw' => $counterpartyName ? trim($counterpartyName) : null,
            'counterparty_inn' => $counterpartyInn   ? trim($counterpartyInn) : null,
            'counterparty_acc' => $counterpartyAcc   ? trim($counterpartyAcc) : null,
            'purpose_raw'      => $purpose ? trim($purpose) : null,
            // Поля для записи в операцию
            'external_id'      => $docNumber ? (string) $docNumber : null,
            'external_date'    => $docDate,
            // note формируется: [Номер от Дата] НазначениеПлатежа
            'note'             => $this->buildNote($docNumber, $docDate, $purpose),
        ];
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

    private function buildNote(?string $number, ?string $date, ?string $purpose): ?string
    {
        $parts = [];

        if ($number || $date) {
            $prefix = '[';
            if ($number) $prefix .= $number;
            if ($number && $date) $prefix .= ' от ';
            if ($date) $prefix .= $date;
            $prefix .= ']';
            $parts[] = $prefix;
        }

        if ($purpose) {
            $parts[] = trim($purpose);
        }

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
