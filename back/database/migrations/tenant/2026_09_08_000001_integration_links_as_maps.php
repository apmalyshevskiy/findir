<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * `integration_links` начинает хранить не только «что загружено», но и
 * «чему что соответствует».
 *
 * Раньше привязка счетов 1С жила в отдельной таблице onec_account_map, потому
 * что у файловой загрузки не было строки в `integrations` — а без неё
 * `integration_links` не заполнить. Теперь 1С становится обычной интеграцией
 * (тип onec_bp3_file), `integration_id` настоящий, и привязки любых внешних
 * объектов ложатся в общую таблицу.
 *
 * Строки различаются по `entity`:
 *   account  — счёт 1С → balance_item
 *   subconto — субконто 1С → info
 *   warehouse_invoice — как было у FusionPOS, не трогаем
 *
 * Две правки схемы:
 *   local_id nullable — строка с NULL значит «не переносить». Это решение
 *     человека, и у него нет цели; отсутствие строки означает другое —
 *     «привязки нет, работает поиск по наименованию».
 *   external_name — что показывать человеку. Ключ у субконто нормализованный
 *     («номенклатура|ингредиет»), в интерфейсе такое не покажешь.
 */
return new class extends Migration
{
    private const TYPE = 'onec_bp3_file';

    public function up(): void
    {
        $conn = Schema::getConnection()->getName();

        DB::connection($conn)->statement(
            'ALTER TABLE integration_links MODIFY local_id BIGINT UNSIGNED NULL'
        );

        if (!Schema::connection($conn)->hasColumn('integration_links', 'external_name')) {
            Schema::connection($conn)->table('integration_links', function (Blueprint $table) {
                $table->string('external_name', 255)->nullable()->after('external_id');
            });
        }

        $this->moveAccountMap($conn);

        Schema::connection($conn)->dropIfExists('onec_account_map');
    }

    /**
     * Перенос привязки счетов из onec_account_map.
     *
     * Интеграцию заводим здесь же: до сих пор её было негде создать, а без неё
     * перенести строки не во что. Проект берём из ключа настроек — раньше он
     * лежал там, теперь его место в настройках интеграции.
     */
    private function moveAccountMap(string $conn): void
    {
        if (!Schema::connection($conn)->hasTable('onec_account_map')) return;

        $rows = DB::connection($conn)->table('onec_account_map as m')
            ->join('balance_items as b', 'b.id', '=', 'm.bi_id')
            ->select('m.account', 'm.bi_id', 'b.code')
            ->get();

        $projectId = DB::connection($conn)->table('settings')
            ->where('key', 'onec_project_id')->value('value');

        // Ни привязок, ни проекта — компания 1С не пользовалась, заводить
        // интеграцию не за чем
        if ($rows->isEmpty() && !$projectId) return;

        $now = now();

        $integrationId = DB::connection($conn)->table('integrations')->insertGetId([
            'type'       => self::TYPE,
            'name'       => '1С:Бухгалтерия 3.0',
            'is_active'  => 1,
            'settings'   => json_encode(
                ['project_id' => $projectId ? (int) $projectId : null],
                JSON_UNESCAPED_UNICODE
            ),
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        foreach ($rows as $row) {
            DB::connection($conn)->table('integration_links')->insert([
                'integration_id' => $integrationId,
                'entity'         => 'account',
                'external_id'    => $row->account,
                'external_name'  => $row->account,
                'local_type'     => 'balance_item',
                'local_id'       => $row->bi_id,
                'synced_at'      => $now,
                'created_at'     => $now,
                'updated_at'     => $now,
            ]);
        }

        DB::connection($conn)->table('settings')->where('key', 'onec_project_id')->delete();
    }

    public function down(): void
    {
        $conn = Schema::getConnection()->getName();

        if (!Schema::connection($conn)->hasTable('onec_account_map')) {
            Schema::connection($conn)->create('onec_account_map', function (Blueprint $table) {
                $table->id();
                $table->string('account', 20);
                $table->unsignedBigInteger('bi_id');
                $table->timestamps();
                $table->unique('account');
                $table->foreign('bi_id')->references('id')->on('balance_items')->cascadeOnDelete();
            });
        }

        $integrations = DB::connection($conn)->table('integrations')
            ->where('type', self::TYPE)->get();

        foreach ($integrations as $integration) {
            $links = DB::connection($conn)->table('integration_links')
                ->where('integration_id', $integration->id)
                ->where('entity', 'account')
                ->whereNotNull('local_id')
                ->get();

            foreach ($links as $link) {
                DB::connection($conn)->table('onec_account_map')->updateOrInsert(
                    ['account' => $link->external_id],
                    ['bi_id' => $link->local_id, 'created_at' => now(), 'updated_at' => now()],
                );
            }

            $projectId = data_get(json_decode((string) $integration->settings, true), 'project_id');
            if ($projectId) {
                DB::connection($conn)->table('settings')->updateOrInsert(
                    ['key' => 'onec_project_id'],
                    ['value' => $projectId, 'created_at' => now(), 'updated_at' => now()],
                );
            }

            // Привязки субконто вернуть некуда — таблицы под них не было.
            // Строки уйдут вместе с интеграцией по каскаду
            DB::connection($conn)->table('integrations')->where('id', $integration->id)->delete();
        }

        if (Schema::connection($conn)->hasColumn('integration_links', 'external_name')) {
            Schema::connection($conn)->table('integration_links', function (Blueprint $table) {
                $table->dropColumn('external_name');
            });
        }

        DB::connection($conn)->table('integration_links')->whereNull('local_id')->delete();
        DB::connection($conn)->statement(
            'ALTER TABLE integration_links MODIFY local_id BIGINT UNSIGNED NOT NULL'
        );
    }
};
