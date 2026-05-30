#!/usr/bin/env php
<?php
/**
 * Сравнение результатов бенчмарка MySQL vs MariaDB.
 *
 * Запуск:
 *   php compare-results.php mysql.json mariadb.json
 */

if ($argc < 3) {
    fwrite(STDERR, "Usage: php compare-results.php <mysql.json> <mariadb.json>\n");
    exit(1);
}

$a = json_decode(file_get_contents($argv[1]), true);
$b = json_decode(file_get_contents($argv[2]), true);

if (!$a || !$b) {
    fwrite(STDERR, "Не удалось распарсить JSON\n");
    exit(1);
}

echo "\n";
echo "════════════════════════════════════════════════════════════════════════\n";
echo "  FINDIR Benchmark — Сравнение\n";
echo "════════════════════════════════════════════════════════════════════════\n";
echo sprintf("  A: %-15s  (%s)\n", $a['label'], $a['db_version']);
echo sprintf("  B: %-15s  (%s)\n", $b['label'], $b['db_version']);
echo "  Параметры: " . json_encode($a['params']) . "\n";
echo "────────────────────────────────────────────────────────────────────────\n";

$labels = [
    'incoming_post_avg_ms' => 'Проведение приходной (avg)',
    'outgoing_post_avg_ms' => 'Проведение расходной (avg)',
    'cost_calc_avg_ms'     => 'Расчёт себестоимости (avg)',
    'osv_avg_ms'           => 'ОСВ-запрос (avg)',
    'incoming_post_total_ms' => 'Приходные накладные (total)',
    'outgoing_post_total_ms' => 'Расходные накладные (total)',
    'osv_total_ms'         => 'ОСВ — все прогоны (total)',
    'cost_calc_total_ms'   => 'Себестоимость — все прогоны',
    'balance_changes_rows' => 'Строк в balance_changes',
];

printf("  %-32s %12s %12s %10s\n", 'Метрика', $a['label'], $b['label'], 'Δ %');
echo "  " . str_repeat('-', 68) . "\n";

foreach ($labels as $key => $name) {
    $va = $a['results'][$key] ?? null;
    $vb = $b['results'][$key] ?? null;
    if ($va === null || $vb === null) continue;

    if ($key === 'balance_changes_rows') {
        printf("  %-32s %12d %12d %10s\n", $name, $va, $vb, $va === $vb ? 'OK' : 'ДИФФ!');
        continue;
    }

    $delta = $va > 0 ? round(($vb - $va) / $va * 100, 1) : 0;
    $sign = $delta > 0 ? '+' : '';
    $marker = $delta < -5 ? ' ⚡' : ($delta > 5 ? ' ⚠' : '');
    printf("  %-32s %12.2f %12.2f %9s%s\n", $name, $va, $vb, "{$sign}{$delta}%", $marker);
}

echo "\n";
echo "  Δ% — на сколько B медленнее A. Отрицательное = B быстрее.\n";
echo "  ⚡ — B быстрее на >5%   ⚠ — B медленнее на >5%\n";
echo "════════════════════════════════════════════════════════════════════════\n\n";
