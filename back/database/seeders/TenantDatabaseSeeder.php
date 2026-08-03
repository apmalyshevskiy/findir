<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;

/**
 * Провижининг новой базы тенанта.
 *
 * Здесь — только то, без чего система не работает: проект, план счетов,
 * настройки разноски и эквайринга.
 *
 * Справочники (info) намеренно НЕ заполняются: набор статей ДДС, расходов и
 * доходов зависит от бизнес-модели, и навязанный «универсальный» список тенант
 * всё равно переделывает. Вместо этого он выбирает шаблон кнопкой «Заполнить»
 * в разделе «Справочники» — см. App\Services\DictionaryTemplates и
 * database/templates/dictionaries/.
 */
class TenantDatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $this->call([
            ProjectSeeder::class,
            BalanceItemsSeeder::class,
            // Карта разноски автозаполнения выписок (ступень 2 движка правил).
            // Справочников ещё нет, поэтому строки создаются с пустой статьёй ДДС;
            // она доразрешится при применении шаблона справочников.
            CategoryPostingSeeder::class,
            AcquiringFeeRulesSeeder::class,
        ]);
    }
}
