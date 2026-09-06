<?php

namespace App\Console\Commands;

use App\Services\OneC\PostingsFile;
use Illuminate\Console\Command;
use RuntimeException;

/**
 * Проверка файла выгрузки проводок из 1С.
 *
 * Отвечает на два вопроса: правильно ли обработка сформировала файл и какие
 * счета 1С в нём встречаются. Второе — вход в настройку соответствия счетов:
 * заполнять её вслепую, не видя реального списка, бессмысленно.
 */
class InspectPostings extends Command
{
    protected $signature = '1c:inspect-postings
                            {file    : Путь к файлу выгрузки (json)}
                            {--full  : Показать все проблемные строки, а не первые двадцать}';

    protected $description = 'Проверить файл выгрузки проводок из 1С и показать сводку';

    public function handle(): int
    {
        $path = $this->argument('file');

        if (!is_file($path)) {
            $this->error("Файл не найден: {$path}");
            return self::FAILURE;
        }

        try {
            $file = PostingsFile::parse((string) file_get_contents($path));
        } catch (RuntimeException $e) {
            $this->error($e->getMessage());
            return self::FAILURE;
        }

        $meta    = $file['meta'];
        $summary = PostingsFile::summary($file);

        $this->line('');
        $this->info('Файл: ' . $path . ' (' . $this->size($path) . ')');

        $this->table([], array_filter([
            ['Версия формата', $meta['version']],
            $meta['source']       ? ['Источник',    $this->flat($meta['source'])] : null,
            $meta['organization'] ? ['Организация', $this->flat($meta['organization'])] : null,
            $meta['period']       ? ['Период выгрузки', $this->flat($meta['period'])] : null,
            $meta['exported_at']  ? ['Сформирован', $meta['exported_at']] : null,
        ]));

        // Разобрано может быть меньше, чем в файле: испорченные проводки
        // отброшены. Молчать об этом нельзя — потерялись бы деньги
        $lost = $meta['total_in_file'] - $summary['count'];

        $this->line('');
        $this->line('Проводок в файле:  ' . $meta['total_in_file']);
        $this->line('Разобрано:         ' . $summary['count'] . ($lost > 0 ? "  (отброшено: {$lost})" : ''));
        $this->line('Даты проводок:     ' . ($summary['date_from'] ?: '—') . ' … ' . ($summary['date_to'] ?: '—'));
        $this->line('Сумма по проводкам: ' . number_format($summary['amount'], 2, ',', ' '));

        $this->accounts($summary['accounts']);
        $this->subconto($summary['subconto']);
        $this->problems($file['problems']);

        // Отброшенные проводки — это не «предупреждение», это неполная
        // выгрузка. Ненулевой код возврата, чтобы такое не проехало в скрипте
        return $file['problems'] ? self::FAILURE : self::SUCCESS;
    }

    private function accounts(array $accounts): void
    {
        $this->line('');
        $this->info('Счета 1С в файле (' . count($accounts) . ') — их и предстоит сопоставить:');

        $rows = [];
        foreach ($accounts as $code => $count) {
            $rows[] = [$code, $count];
        }

        $this->table(['Счёт', 'Проводок'], $rows);
    }

    private function subconto(array $kinds): void
    {
        if (!$kinds) {
            $this->warn('Субконто в файле нет — аналитику сопоставлять не с чем');
            return;
        }

        $this->info('Виды субконто (' . count($kinds) . '):');

        $rows = [];
        foreach ($kinds as $kind => $count) {
            $rows[] = [$kind, $count];
        }

        $this->table(['Вид субконто', 'Встречается'], $rows);
    }

    private function problems(array $problems): void
    {
        if (!$problems) {
            $this->info('Проблем не найдено.');
            return;
        }

        $this->line('');
        $this->error('Проблемы (' . count($problems) . '):');

        $show = $this->option('full') ? $problems : array_slice($problems, 0, 20);

        foreach ($show as $p) {
            if ($p['line'] === null) {
                $this->line('  … и ещё ' . $p['more'] . ' таких же');
                continue;
            }
            $this->line('  проводка ' . $p['line'] . ': ' . $p['message']);
        }

        if (!$this->option('full') && count($problems) > count($show)) {
            $this->line('  … ещё ' . (count($problems) - count($show)) . ' — запустите с --full');
        }
    }

    private function flat($value): string
    {
        if (!is_array($value)) return (string) $value;

        $parts = [];
        foreach ($value as $k => $v) {
            if ($v === null || $v === '') continue;
            $parts[] = is_array($v) ? $k . ': …' : $k . ': ' . $v;
        }

        return implode(', ', $parts);
    }

    private function size(string $path): string
    {
        $bytes = (int) filesize($path);

        return $bytes < 1024 * 1024
            ? round($bytes / 1024, 1) . ' КБ'
            : round($bytes / 1024 / 1024, 1) . ' МБ';
    }
}
