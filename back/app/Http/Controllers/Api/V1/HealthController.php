<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;

class HealthController extends Controller
{
    public function __invoke()
    {
        $checks = [];
        
        // 1. Проверка БД + Замер задержки (Latency)
        $start = microtime(true);
        try {
            DB::select('SELECT 1');
            $checks['mysql'] = [
                'status' => 'ok',
                'latency_ms' => round((microtime(true) - $start) * 1000, 2)
            ];
        } catch (\Exception $e) {
            $checks['mysql'] = ['status' => 'error', 'message' => 'Connection failed'];
        }

        // 2. Проверка Redis
        try {
            Cache::put('health_check', 'ok', 5);
            $checks['redis'] = Cache::get('health_check') === 'ok' ? 'ok' : 'error';
        } catch (\Exception $e) {
            $checks['redis'] = 'error';
        }

        // 3. Ресурсы сервера
        $checks['server'] = [
            'disk_free' => $this->getFreeDiskSpace(),
            'memory_usage' => $this->getMemoryUsage(),
            'load_average' => function_exists('sys_getloadavg') ? sys_getloadavg() : 'n/a',
        ];

        // 4. Версии ПО
        $versions = [
            'php'      => PHP_VERSION,
            'laravel'  => app()->version(),
            'npm'      => $this->getNpmVersion(),
            'tailwind' => $this->getTailwindVersion(),
        ];

        // Проверяем, нет ли критических ошибок в основных сервисах
        $allOk = ($checks['mysql']['status'] ?? '') === 'ok' && $checks['redis'] === 'ok';

        return response()->json([
            'status'   => $allOk ? 'ok' : 'degraded',
            'timestamp' => now()->toIso8601String(),
            'versions' => $versions,
            'checks'   => $checks,
        ], $allOk ? 200 : 503);
    }

    private function getFreeDiskSpace(): string
    {
        $free = disk_free_space(base_path());
        $total = disk_total_space(base_path());
        $percentage = round(($free / $total) * 100, 2);
        
        return round($free / 1024 / 1024 / 1024, 2) . " GB ($percentage% free)";
    }

    private function getMemoryUsage(): string
    {
        $usage = memory_get_usage(true);
        return round($usage / 1024 / 1024, 2) . " MB";
    }

    private function getNpmVersion(): string
    {
        return trim(shell_exec('npm -v') ?? 'n/a');
    }

    private function getTailwindVersion(): string
    {
        $path = base_path('package.json');
        if (!File::exists($path)) return 'n/a';

        $json = json_decode(File::get($path), true);
        return $json['devDependencies']['tailwindcss'] ?? $json['dependencies']['tailwindcss'] ?? 'n/a';
    }
}