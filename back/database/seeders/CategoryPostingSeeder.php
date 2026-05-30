<?php

namespace Database\Seeders;

use App\Services\PaymentCategory;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Засев карты разноски (category_postings) для тенанта — ступень 2 движка правил.
 *
 * Стандартный Laravel-сидер: работает с ДЕФОЛТНЫМ соединением, которое
 * MigrateTenants уже переключил на тенантную БД перед запуском сидеров.
 * Поэтому вызывается как все остальные — через $this->call([...]) в
 * TenantDatabaseSeeder, без аргументов.
 *
 * Заводим строки по одной категории, по мере подключения видов операций.
 * Шаг А: только TRANSFER.
 *
 * Статья ДДС резолвится по подстроке имени в справочнике flow тенанта —
 * тем же способом, что и в матчере, чтобы поведение совпадало. Поэтому
 * сидер обязан идти ПОСЛЕ InfoSeeder (статьи должны уже существовать).
 * Если статью не нашли, строка всё равно создаётся (flow_info_id = null) —
 * тенант выберет статью вручную в настройках.
 *
 * Идемпотентно: повторный запуск не плодит дубли и не затирает выбранную
 * тенантом статью пустотой.
 */
class CategoryPostingSeeder extends Seeder
{
    public function run(): void
    {
        // category => [counter_account_code, flow по подстроке, partner_mode]
        $defaults = [
            PaymentCategory::TRANSFER => [
                'counter_account_code' => 'А100',
                'flow_name_like'       => 'перемещение денег',
                'partner_mode'         => 'none',
            ],
            // Комиссия банка/эквайринга. Дефолт — П589 + «Административные расходы»
            // (пока нет отдельной статьи «Комиссия банка»; тенант сменит в настройках).
            // Распознавание (ИНН банка + «плата за/комисси») тенант заводит правилом.
            PaymentCategory::ACQUIRING_FEE => [
                'counter_account_code' => 'П589',
                'flow_name_like'       => 'административные расходы',
                'partner_mode'         => 'none',
            ],
            // Следующие категории добавляем по мере подключения видов (шаги 3+).
        ];

        foreach ($defaults as $category => $cfg) {
            $this->upsert(
                $category,
                $cfg['counter_account_code'] ?? null,
                $this->findFlowIdByName($cfg['flow_name_like'] ?? null),
                $cfg['partner_mode'] ?? 'from_inn'
            );
        }
    }

    private function upsert(string $category, ?string $accountCode, ?int $flowId, string $partnerMode): void
    {
        $exists = DB::table('category_postings')->where('category', $category)->exists();

        if ($exists) {
            // Обновляем дефолты, но НЕ трогаем flow, если статью не нашли —
            // иначе при повторном засеве сотрём выбор тенанта.
            $update = [
                'counter_account_code' => $accountCode,
                'partner_mode'         => $partnerMode,
                'is_active'            => true,
                'updated_at'           => now(),
            ];
            if ($flowId !== null) {
                $update['flow_info_id'] = $flowId;
            }
            DB::table('category_postings')->where('category', $category)->update($update);
            return;
        }

        DB::table('category_postings')->insert([
            'category'             => $category,
            'counter_account_code' => $accountCode,
            'flow_info_id'         => $flowId,
            'partner_mode'         => $partnerMode,
            'is_active'            => true,
            'created_at'           => now(),
            'updated_at'           => now(),
        ]);
    }

    private function findFlowIdByName(?string $like): ?int
    {
        if (!$like) return null;

        $row = DB::table('info')
            ->where('type', 'flow')
            ->where('is_active', true)
            ->whereNull('deleted_at')
            ->whereRaw('LOWER(name) LIKE ?', ['%' . mb_strtolower($like) . '%'])
            ->orderBy('id')
            ->value('id');

        return $row ? (int) $row : null;
    }
}
