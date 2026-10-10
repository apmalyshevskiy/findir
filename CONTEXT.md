# Описание проекта: FINDIR (Financial Director)

Управленческий учёт для собственника: проводки, документы, оборотка, бюджеты,
баланс и движение денег. Один контур данных на компанию (тенант), всё
остальное — надстройки над ним.

**Источник истины — код.** Этот документ описывает устройство и причины
решений; точные списки маршрутов, полей и значений смотрите в
`routes/api.php`, миграциях и сервисах. Где документ расходится с кодом —
прав код.

---

## 1. Архитектура и стек технологий

- **Frontend:** React 19, Vite (порт 3000), Tailwind CSS v4, `react-router`, `xlsx`
- **Backend:** Laravel 12, PHP 8.3, REST API
- **База данных:** MariaDB 11.4 (внешний порт 3307)
- **Кэш и очереди:** Redis + Laravel Horizon
- **Инфраструктура:** Docker Compose
- **Мультитенантность:** кастомная реализация (см. раздел 5)
- **ИИ:** внешний роутер моделей (`Ai\RouterAiClient`), расход считается по токенам

---

## 2. Структура директорий

Перечислены опорные точки, а не всё дерево.

```
findir/
├── back/
│   ├── app/Http/Controllers/Api/V1/
│   │   ├── TenantController.php       # базовый: initTenant(), $this->dbName, $this->scope
│   │   ├── OperationsController.php   # журнал, проведение, история, движения
│   │   ├── BulkOperationsController.php  # массовая правка операций + откат
│   │   ├── DocumentsController.php / CostController.php / DocumentTypesController.php
│   │   ├── BalanceSheetController.php # ОСВ с мульти-аналитикой и иерархией
│   │   ├── ReportsController.php      # баланс и ОДДС
│   │   ├── BudgetController.php       # БДР/БДДС/платёжный календарь, план-факт
│   │   ├── InfoController.php         # справочники, массовая правка, ссылки
│   │   ├── IntegrationsController.php / OneCController.php / BankStatementController.php
│   │   ├── FundSchemeController.php / FundsController.php / FundPlanDocController.php
│   │   ├── AiController.php / AiDialogsController.php
│   │   ├── UsersController.php / RolesController.php / SettingsController.php
│   │   ├── BackupController.php / ChangeLogController.php / DashboardController.php
│   │   └── OnboardingController.php / DictionaryTemplatesController.php
│   ├── app/Services/
│   │   ├── TenantService.php          # подключение к базе тенанта
│   │   ├── Access.php                 # разделы прав, карта маршрутов, уровни
│   │   ├── AccountScope.php           # закрытые должностью счета
│   │   ├── AnalyticSlots.php          # слоты аналитики счёта (набор типов / any)
│   │   ├── ChartOfAccounts.php        # каталог системных счетов и их группы
│   │   ├── InfoReferences.php         # кто ссылается на элемент справочника
│   │   ├── BulkOperationEditor.php / BulkInfoEditor.php
│   │   ├── TenantBackupService.php    # выгрузка и восстановление данных компании
│   │   ├── History/                   # History, HasHistory, HistoryPresenter, HistoryRestorer
│   │   ├── Documents/                 # DocumentService, UniversalStrategy, CostCalculatorService
│   │   ├── Integrations/              # IntegrationRegistry, FusionPos/, OneC/
│   │   ├── Ai/                        # OperationDraftService, AnalyticsQueryService, AiUsage
│   │   ├── OneC/                      # PostingsFile, PostingsImporter
│   │   ├── Acquiring/AcquiringFeeRules.php
│   │   ├── ClientBankExchangeParser.php / BankStatementMatcher.php / PaymentCategory.php
│   │   └── DictionaryTemplates.php
│   ├── database/migrations/tenant/    # схема тенанта (хронология — раздел 22)
│   └── routes/api.php
│
├── front/src/
│   ├── api/                  # по файлу на раздел; client.js — axios + Bearer + 401
│   ├── pages/                # по файлу на экран (см. App.jsx)
│   ├── components/
│   │   ├── Layout.jsx            # меню по разделам прав, шапка, справка, недавние
│   │   ├── ObjectOpener.jsx      # открыть операцию/документ/элемент поверх страницы
│   │   ├── OperationForm.jsx / InfoItemCard.jsx / InfoSelect.jsx
│   │   ├── BulkEditOperations.jsx / BulkEditInfo.jsx
│   │   ├── InfoReferencesModal.jsx / ObjectHistory.jsx / OperationsPeek.jsx
│   │   └── Busy.jsx              # Spinner, Ring, TopBusy, SkeletonRows
│   ├── help/                 # справка в приложении: *.md + index.js (реестр)
│   ├── utils/                # period, datetime, recent, infoLabels, osv, reportSheets
│   └── App.jsx
├── docker-compose.yml
└── docker-compose.prod.yml
```

---

## 3. Docker-контейнеры

| Контейнер | Назначение | Порт |
|-----------|-----------|------|
| `findir_php` | PHP-FPM, Laravel | — |
| `findir_nginx` | Nginx | 80 |
| `findir_mariadb` | MariaDB 11.4 | 3307 |
| `findir_redis` | Redis | — |
| `findir_horizon` | Laravel Horizon | — |
| `findir_scheduler` | Laravel Scheduler | — |
| `findir_front` | Node/Vite | 3000 |
| `findir_phpmyadmin` | phpMyAdmin | 8080 |
| `findir_redis_ui` | Redis Commander | 8081 |
| `findir_mailpit` | Локальная почта | 8025 / 1025 |

---

## 4. Ключевые сущности и схема данных

### `info` — справочники

```sql
id, parent_id, code VARCHAR(35), name,
type ENUM(partner, employee, department, cash, flow, expenses, product, revenue),
description, inn VARCHAR(12), sort_order, is_active,
default_expense_id   -- для type=flow: статья расхода по умолчанию (self-ref)
expense_kind VARCHAR(20)  -- fixed | variable | investment, смысл только у expenses
flow_kind    VARCHAR(20)  -- operating | investing | financing, смысл только у flow
timestamps, soft_deletes
```

`expense_kind` делит расходы в БДР и достраивает промежуточные прибыли;
`flow_kind` раскладывает ОДДС на три раздела. Умолчания (`fixed`, `operating`)
выбраны так, чтобы отчёты работали до разметки.

Вид хранится **на самой статье**, а не вторым деревом и не вторым счётом:
меняется только то, в какую часть отчёта статья попадёт.

### `balance_items` — план счетов

```sql
id, parent_id, name, code VARCHAR(20),
info_1_type VARCHAR(100), info_1_turnover_only,
info_2_type VARCHAR(100), info_2_turnover_only,
info_3_type VARCHAR(100), info_3_turnover_only,
is_system, has_quantity, timestamps, soft_deletes
```

**Слот хранит набор типов, а не один тип** (`AnalyticSlots`): `null` — слота нет,
`'partner'` — один справочник, `'partner,employee'` — только эти два, `'any'` —
любой. «Любой» — отдельное слово, а не перечисление восьми: девятый справочник
счета с `any` примут сами.

`info_N_turnover_only` — аналитика только для оборотов: в сальдо не разворачивается.

**Каталог счетов** — `ChartOfAccounts`. Группы: `assets`, `liabilities`,
`capital`, `profit`. Часть счетов создаётся при регистрации (`default`),
остальные добавляются кнопкой из каталога. Идентификаторы фиксированы и
одинаковы у всех тенантов; свои счета тенанта начинаются с 990.

| Код | Название | Группа | Слоты | has_quantity |
|-----|---------|--------|-------|-------------|
| А100 | ДЕНЕЖНЫЕ СРЕДСТВА | assets | cash, flow | 0 |
| А110 | ДЕНЬГИ В ПУТИ | assets | cash, flow | 0 |
| А200 | ТОВАРЫ | assets | product, department | 1 |
| А230 | МАТЕРИАЛЫ ДЛЯ ПРОИЗВОДСТВА | assets | product | 1 |
| А240 | ПРОДУКТЫ | assets | product | 1 |
| А405 | КЛИЕНТЫ | assets | partner | 0 |
| П100 | ПОСТАВЩИКИ | liabilities | partner | 0 |
| П335 | СОТРУДНИКИ | liabilities | employee | 0 |
| П340 | ГОСУДАРСТВО | liabilities | — | 0 |
| П500 | КАПИТАЛ (+ П505/П550/П555) | capital | — | 0 |
| П585 | ТЕКУЩАЯ ЧИСТАЯ ПРИБЫЛЬ | profit | — | 0 |
| П587 | ДОХОДЫ | profit | revenue, product | 0 |
| П588 | СЕБЕСТОИМОСТЬ | profit | revenue, product | 0 |
| П589 | РАСХОДЫ | profit | expenses | 0 |

### `operations` — проводки (двойная запись)

```sql
id, date TIMESTAMP, project_id, amount, quantity,
in_bi_id,  in_info_1_id,  in_info_2_id,  in_info_3_id,  in_quantity,
out_bi_id, out_info_1_id, out_info_2_id, out_info_3_id, out_quantity,
note, content,
source VARCHAR(20),       -- manual | bank_import | document | onec | fusionpos | ai
created_by, is_posted,
external_id, external_date,
table_name VARCHAR(50), table_id VARCHAR(36),   -- 'documents' + documents.id
timestamps, soft_deletes
```

**Важно:** операции с `table_name='documents'` нельзя редактировать и удалять
через API (422) — их правит документ. Копировать такую операцию можно.

`is_posted = 0` — операция существует, но в оборотку и отчёты не идёт.

### `balance_changes` — знаковый регистр (ведут триггеры)

```sql
operation_id, date, project_id, amount, quantity,
bi_id, side ENUM(debit, credit),
info_1_id, info_2_id, info_3_id, content
```

Это главная таблица отчётности, и на её свойствах держатся все отчёты:

- **сальдо = `SUM(amount)`** при `date <= дата`; обороты — та же сумма с разбивкой
  по `side`;
- **пассивные счета хранят кредит отрицательным**, поэтому
  Σ(активы) + Σ(пассивы) = 0 по построению: баланс сходится сам, а не
  подгоняется;
- `quantity` со знаком (+приход, −расход) и только для счетов с `has_quantity=1`;
- одна операция даёт две строки, связанные `operation_id` — так отчёт отличает
  внутреннее перемещение от движения наружу.

Триггеры: `insert_changes` / `update_changes` / `delete_changes` на `operations`.
`side` заполняется ими же.

### `object_versions` — история правок

```sql
id, entity VARCHAR(20), entity_id, version, action VARCHAR(10),
diff JSON, snapshot JSON,
source VARCHAR(20),   -- manual | ai | bulk | onec | fusionpos | bank_import | document | auto
batch VARCHAR(40),    -- ULID одной пачки: одно действие человека
user_id, restored_from, created_at
```

Пишется приложением, а не триггером: триггер поймал бы всё, но не знает ни
человека, ни причины, а в журнале ищут именно их. Плата — массовые `UPDATE`
мимо моделей истории не поднимают, такие места зовут `History::record()` сами.

### `users` / `roles` — доступ

```sql
users: id, name, email, password, role_id, is_active, last_login_at, timestamps
roles: id, code, name, permissions JSON, denied_accounts JSON, is_system, sort_order
```

`permissions` — карта «раздел → уровень» (`none` / `view` / `edit`),
`denied_accounts` — отмеченные счета, закрытые вместе со всем поддеревом.
Пользователь без должности прав не имеет вовсе. Подробно — раздел 6.

### `document_types` / `documents` / `document_items`

```sql
document_types: id, code, name,
  head_bi_id, head_side ENUM(debit, credit), item_bi_id,
  show_quantity, show_price, show_vat, line_head_fields JSON,
  engine VARCHAR(30),   -- universal | outgoing_invoice
  is_system, is_active, sort_order

documents: id, date, number, external_number, external_date, project_id,
  type VARCHAR  -- код из document_types
  status ENUM(draft, posted, cancelled), created_by,
  bi_id, info_1_id..3, department_id,
  revenue_bi_id, cogs_bi_id, revenue_item_id,
  amount, amount_vat, content, note, extra JSON, timestamps, soft_deletes

document_items: id, document_id FK CASCADE, sort_order, kind,
  bi_id, info_1_id..3, head_bi_id, head_info_1_id..3,
  quantity, price, amount, amount_vat, amount_cost, content, note, timestamps
```

Вид документа — **настраиваемая запись**, а не константа в коде: счета шапки и
строки, сторона шапки и состав полей задаются в `document_types`, а проводки
собирает `UniversalStrategy`. Расходная накладная осталась отдельным движком
(`outgoing_invoice`) из-за себестоимости.

`head_*` у строки — переопределение шапки для этой строки (`line_head_fields`
говорит, какие поля показывать).

### Бюджетирование

```sql
budget_documents: id, name, type ENUM(dds, bdr, pdc),
  period_from, period_to, project_id,
  status ENUM(draft, approved, archived),
  structure JSON,     -- разрез БДР по разделам
  created_by, timestamps, soft_deletes

budget_items: id, budget_document_id, article_id, article_2_id, article_3_id,
  section ENUM(revenue, cost, expenses) NULL,   -- только БДР
  cash_id, period_date, content, amount, timestamps

budget_opening_balances: id, budget_document_id, cash_id, amount, is_manual
```

`structure` — список уровней на раздел: `{"expenses": [{"type":"department",
"tree":true}, {"type":"expenses","tree":false}]}`. Номер слота не указывается:
счёт сам объявил, что принимает, — `bdrSections()` сводит настройку со слотами.
Пустая настройка означает «как объявил счёт» (один уровень по первому слоту) —
ровно поведение бюджетов, заведённых до появления разреза.

Разделы БДР жёстко привязаны к счетам: `revenue → П587`, `cost → П588`,
`expenses → П589`.

### Фонды

```sql
fund_schemes: id, name, note, week_start_dow, start_date, income_flow_ids JSON, is_active
funds:        id, scheme_id, name, percent, flow_info_ids JSON, opening_balance, sort_order
fund_plan_docs:  id, scheme_id, week_start, status, note, fund_percents JSON, created_by
fund_plan_lines: id, doc_id, fund_id, flow_info_id, amount, comment, accepted, sort_order
```

### Интеграции

```sql
integrations:      id, type VARCHAR(40), name, is_active, credentials, settings JSON,
                   last_run_at, last_run_status, last_run_message
integration_links: id, integration_id, entity, external_id, external_name,
                   local_type, local_id, fingerprint, synced_at
integration_runs:  id, integration_id, entity, mode, period_from, period_to, status,
                   fetched, created, updated, skipped, failed, message, details JSON,
                   started_at, finished_at
```

Имя типа складывается из системы, конфигурации и способа обмена:
`onec_bp3_file` — 1С, Бухгалтерия 3.0, обмен файлом. Завтрашний `onec_bp3_http`
встанет рядом, не переименовывая сегодняшнее. Сейчас есть `onec_bp3_file` и
`fusionpos`. Драйверы — через `IntegrationRegistry::driverFor()`.

`integration_links` — соответствия «внешний объект → наш»: таблица отображений,
а не журнал.

### Прочие таблицы

```sql
operation_templates: id, name, payload JSON, use_count, last_used_at, sort_order
bulk_update_log:     id, filter JSON, changes_set JSON, undo JSON, affected,
                     description, reverted_at, created_by   -- откат массовой правки
ai_dialogs:          id, user_id, title, turns JSON, history JSON,
                     drafts_total, drafts_saved, cost, total_tokens
ai_usage:            id, feature, model, input_tokens, output_tokens, total_tokens,
                     cost, currency, raw JSON, user_id
settings:            key VARCHAR(100) PK, value TEXT
category_postings, payment_classification_rules   -- движок автозаполнения выписки
balance              -- агрегированные остатки; сейчас не заполняется, оставлена
                     -- под будущее закрытие периода: CostCalculatorService умеет
                     -- читать её вместе с settings.balance_actual_date
```

`settings` хранит, среди прочего, `edit_lock_date` (дата запрета редактирования),
правила эквайринга и раскладку дашборда по пользователям.

---

## 5. Мультитенантность

**Кастомная, не stancl/tenancy pipeline.**

- Центральная БД: `findir_central` — пользователи, тенанты, домены
- Тенантные БД: `findir_{slug}`
- Заголовок: `X-Tenant: {slug}`
- `TenantController::initTenant()` → `TenantService::connect($slug)` → `$this->dbName`,
  `$this->scope` (AccountScope), `$this->editLockDate()`

**Применение миграций:**

```bash
docker compose exec -T php php artisan tenants:migrate
docker compose exec -T php php artisan tenants:migrate --tenant=kafe
docker compose exec -T php php artisan tenants:migrate --tenant=kafe --fresh --seed --force
```

Список тенантов — `DB::table('tenants')->pluck('id')`. Пользователи у каждого
тенанта свои (в его базе), центральная база держит вход и привязку.

---

## 6. Права доступа

Два независимых механизма.

**Разделы (`Access`).** Раздел → уровень `none` / `view` / `edit`. Разделы
повторяют пункты меню: настройка должности должна читаться глазами. Сейчас их
одиннадцать: `dashboard`, `ai`, `operations`, `documents`, `reports`,
`exchange`, `budget`, `dictionaries`, `settings`, `users`, `backup`.

Уровень запроса выводится из метода и пути (`Access::levelFor()`), раздел — из
первого сегмента (`routeMap()`). Исключения перечислены явно и каждое с
причиной:

- `readOnlyPosts()` — предпросмотры и расчёты шлются POST ради тела запроса, а
  не ради записи;
- `heavyReads()` — `backup/export` требует `edit`: по виду чтение, по существу
  вся база одним файлом;
- `personalWrites()` — раскладка дашборда лежит под ключом с id пользователя;
- `sectionOverrides()` — `ai/usage` относится к настройкам: трата это деньги
  компании, а не работа с помощником.

**Закрытые счета (`AccountScope`).** Поперечный разрез: какие счета вырезать из
раздела, в который пустили. Список берётся у должности и раскрывается по
иерархии (закрыл группу — закрыл всё, что в ней есть и появится). Все
вызывающие сначала спрашивают `isEmpty()`: у администратора запрос не должен
получать лишнего условия.

Операция с одной закрытой стороной показывается с замазанной стороной — иначе у
кассира не сошёлся бы остаток по кассе.

---

## 7. История изменений

`History` — синглтон на запрос, держит контекст (кто и откуда). `HasHistory` —
трейт модели. `HistoryPresenter` — человеческие подписи полей и значений,
`HistoryRestorer` — возврат к версии.

- **Источник** (`source`) ставится вызывающим: `app(History::class)->source('bulk')`.
  Новый вызов начинает новую **пачку** (`batch`, ULID) — одно действие человека,
  даже если оно правит тридцать объектов.
- Восстановление проверяет дату запрета и запрет смены справочника; удалённый
  объект при возврате версии оживает.
- Журнал: `GET /change-log` (общий), `GET /{entity}/{id}/history` (объекта).
  Маршруты истории живут при своих объектах, потому что раздел прав берётся по
  первому сегменту пути.

---

## 8. API

Префикс `/api/v1/`. Auth: Bearer token. Тенант: `X-Tenant`.
Полный список — `routes/api.php`; ниже группы и то, что стоит знать.

| Группа | Маршруты |
|--------|----------|
| Вход | `POST /login`, `/register`, `/logout`, `GET /me`, `POST /me/password`, `GET /check-domain`, `/suggest-domain` |
| Люди | `GET/POST/PUT/DELETE /users[/{id}]`, `POST /users/{id}/password`, `.../roles[/{id}]` |
| Дашборд | `GET /dashboard/summary`, `/metrics`, `/revenue-series`, `GET/PUT /dashboard/layout`, `GET /onboarding` |
| Операции | `GET/POST /operations`, `PUT/DELETE /operations/{id}`, `POST /operations/{id}/posting`, `GET /operations/{id}/changes`, `/history`, `POST /operations/{id}/restore/{version}` |
| Массовая правка | `POST /operations/bulk-preview`, `/bulk-update`, `GET /operations/bulk-log`, `POST /operations/bulk-log/{id}/revert` |
| Справочники | `GET/POST /info`, `PUT/DELETE /info/{id}`, `POST /info/bulk-preview`, `/bulk-update`, `GET /info/{id}/references`, `/history`, `POST /info/{id}/restore/{version}`, `GET /dictionary-templates[...]` |
| План счетов | `GET /balance-items`, `POST/PUT/DELETE /balance-items[/{id}]`, `GET/POST /balance-items/catalog` |
| Отчёты | `GET /balance-sheet`, `GET /reports/balance`, `GET /reports/cash-flow` |
| Документы | `GET/POST /documents`, `GET/PUT/DELETE /documents/{id}`, `POST /documents/{id}/post`, `/cancel`, `POST /documents/calculate-cost`, `GET/POST/PUT/DELETE /document-types[/{id}]` |
| Бюджет | `GET/POST/PUT/DELETE /budget-documents[/{id}]`, `GET /budget-report/{id}`, `GET/POST/PUT/DELETE /budget-items[/{id}]`, `PUT /budget-opening-balances/upsert` |
| Фонды | `GET/POST/GET/PUT/DELETE /fund-schemes[/{id}]`, `GET /funds/calc`, `GET/PUT /fund-plan-docs` |
| Обмен | `POST /bank-statements/parse`, `GET/PUT /onec/settings`, `PUT /onec/analytics-map`, `POST /onec/postings/preview`, `/import`, `/inn` |
| Интеграции | `GET /integrations/types`, CRUD `/integrations[/{id}]`, `POST /integrations/{id}/test`, `/preview`, `/object`, `/sync`, `GET /integrations/{id}/dictionaries`, `/runs` |
| Автозаполнение | CRUD `/classification-rules[/{id}]`, `/category-postings[/{id}]` |
| ИИ | `GET /ai/status`, `/usage`, `POST /ai/parse-operation`, `/parse-file`, `/apply-links`, `/apply-bulk`, `/classify-statement`, `/apply-rules`, `/transcribe`, `GET /ai/bulk-log`, `POST /ai/bulk-log/{id}/revert`, CRUD `/ai/dialogs[/{id}]` |
| Шаблоны операций | `GET/POST /operation-templates`, `POST /operation-templates/{id}/use`, `DELETE /operation-templates/{id}` |
| Архивная копия | `GET /backup/summary`, `/export`, `POST /backup/inspect`, `/import` |
| Настройки | `GET/PUT /settings/edit-lock-date`, `/settings/acquiring-fee-rules`, `GET /change-log` |

**Порядок маршрутов важен.** Статические пути объявляются **до** динамических
`{id}`, иначе Laravel принимает слово за идентификатор. Так стоят
`/documents/calculate-cost`, `/balance-items/catalog`, `/integrations/types`,
`/operations/bulk-*`, `/info/bulk-*`.

**Фильтры `GET /balance-sheet`:** `date_from`, `date_to`, `bi_id`, `project_id`,
`info_types[]` (типы аналитик в нужном порядке; `slot1..slot3` — разворот по
самому слоту), `hierarchy_types[]`.

**Фильтры `GET /operations`:** `date_from`, `date_to`, `project_id`, `in_bi_id`,
`out_bi_id`, `info_id`, `ids`, `source`, `q`, `per_page`, `page`.

---

## 9. Система документов

Документ = шапка (`documents`) + строки (`document_items`). При проведении
стратегия создаёт операции с `source='document'`, `table_name='documents'`,
`table_id=id`. При повторном проведении старые операции удаляются начисто,
новые создаются.

**Кнопка «✓ Провести»** сначала сохраняет форму, затем зовёт `/post`: иначе
себестоимость и правки ушли бы в проводки не целиком.

**`UniversalStrategy`** собирает проводку по виду документа: счёт и сторона
шапки из `document_types`, счёт строки — оттуда же или переопределён в строке.
Приходная накладная, авансовый отчёт, начисление ЗП — всё это настройки одного
движка, а не три куска кода.

**`OutgoingInvoiceStrategy`** — расходная накладная, две операции:

```
№1 Выручка:        Дт doc.bi_id (А405) / покупатель
                   Кт doc.revenue_bi_id (П587) / статья дохода / номенклатура
                   Сумма: item.amount
№2 Себестоимость:  Дт doc.cogs_bi_id (П588) / статья дохода / номенклатура
                   Кт item.bi_id (А200/А240) / номенклатура / склад   −qty
                   Сумма: item.amount_cost
```

**Расчёт себестоимости (`CostCalculatorService`)** — средневзвешенная цена на
дату документа (строго `< doc.date`): `цена = sum(amount) / sum(quantity)` по
(bi_id, info_1..3). `amount_cost = min(qty строки, qty остатка) * цена`; при
нулевом или отрицательном остатке — `0` и флаг `negative_stock`.

---

## 10. ОСВ (BalanceSheetController + BalanceSheetPage)

1. Читает `balance_changes` за период (сальдо начальное + обороты + конечное).
2. Для каждого счёта строит дерево аналитик в порядке `info_types[]`.
3. `hierarchy_types[]` решает, строить ли по справочнику иерархию: без него —
   плоский список.
4. Закрытые счета вырезаются `AccountScope`, и под заголовком встаёт
   предупреждение: итог перестаёт быть балансом.

Интерфейс: период, панель `⋯` (проект, счёт, сброс), мультиселект аналитик с
перетаскиванием порядка и тоглом иерархии у каждой, расшифровка по клику на
сумму, экспорт в Excel (`utils/osv.js`).

---

## 11. Бюджетирование

Три вида документа: `dds` (БДДС), `bdr` (БДР), `pdc` (платёжный календарь).
План вводится в черновике, факт подтягивается из `balance_changes`.

**Идентичность строки.** В БДДС строку опознаёт `article_id`; в БДР — **путь по
уровням разреза**: `section:id1.id2:cash:period`. Поэтому смена разреза не
переносит введённый план: он остаётся на прежних путях, и об этом сказано в
интерфейсе.

**Знак плана.** План хранится так же, как факт: в БДР знак даёт раздел
(`sectionSign`: расходы и себестоимость — минус, поле ввода помнит это за
человека), в БДДС и календаре разделов нет и направление знает статья —
поступления плюсом, выплаты минусом. Иначе «движение за период» сложило бы
приход с расходом в одну сторону.

**Разрез** — `structure` на документе, до трёх уровней на раздел, у каждого
уровня вид справочника и способ показа (`tree` — весь справочник с
вложенностью, иначе только задействованное). Выбор ограничен тем, что счёт
раздела объявил в слотах.

**Деление расходов** (`EXPENSE_GROUPS`) по `info.expense_kind` в порядке
вычитания: переменные → постоянные → инвестиционные, с прибылями между ними
(маржинальная, валовая, операционная, чистая). Статья попадает в группу по
**своему** виду, а не родительскому, поэтому одна группа может стоять в
нескольких разделах с разными детьми, не задваивая собственную сумму.

**«Без статьи» (`UNASSIGNED = 0`)** собирает обороты, у которых нет аналитики
нужного уровня, **и те, где в слоте лежит значение чужого типа** (в слоте под
отдел — номенклатура). Второе — защита от молчаливой потери: своей строки у
такого оборота быть не может, а исчезнуть он не должен. `foreignIds` отдаются
в расшифровку, чтобы клик по сумме показал те самые операции. Итог раздела
всегда сходится с обороткой.

---

## 12. Баланс и ОДДС (ReportsController)

Оба отчёта считаются поверх `balance_changes`, ничего нового не хранят.

**Баланс** (`GET /reports/balance`): сальдо каждого счёта на дату, счета
раскладываются по группам каталога; счёт вне каталога определяется по первой
букве кода (`А` — актив, `П` — пассив) — единственное место, где код что-то
решает. Прибыль показывается внутри капитала строкой «Прибыль накопленным
итогом». В ответе `check` = сумма активов и пассивов: ноль означает, что всё
сошлось, не ноль бывает только при закрытых счетах, и тогда отчёт пишет об этом
словами (`partial`).

**ОДДС** (`GET /reports/cash-flow`), прямой метод: денежные счета — те, где
объявлен слот под «Касса/Счёт» и код начинается с `А`. Остатки на начало и
конец, движения группируются по статье ДДС и `side`. **Внутренние перемещения
исключаются** джойном с `operations`: если обе стороны проводки — денежные
счета, строка в отчёт не идёт, иначе перевод из кассы на расчётный счёт раздул
бы и поступления, и выплаты. Разделы — по `info.flow_kind`, плюс «Без статьи
ДДС»: прятать неразнесённое нельзя.

Косвенный метод сознательно не делаем: он для отчётности по стандартам, а не
для управления.

---

## 13. Банковская выписка и автозаполнение

**Формат:** Win-1251, 1C ClientBankExchange v1.03.

**Парсер** (`ClientBankExchangeParser`): `external_id/date`, `counterparty_inn`,
`counterparty_account`, `purpose_raw`, `direction`, `is_self_transfer`; для
эквайринг-свода Т-Банка извлекает комиссию из назначения (`is_acquiring_split`,
`acquiring_fee`).

**Матчер** (`BankStatementMatcher`): двухступенчатая авторазметка (сигнал →
категория → разноска), статья ДДС, статья расхода, партнёр по ИНН, подсказки
ноги комиссии, поиск дублей.

**ИИ добивает остаток:** `POST /ai/classify-statement` разбирает то, что не
опознали правила, и предлагает новые правила (`/ai/apply-rules`).

> Полное описание движка — `AUTOFILL_ENGINE.md` и `AUTOFILL_AND_ACQUIRING.md`.

---

## 14. Интеграции и 1С

**1С:Бухгалтерия 3.0 (файл).** Внешняя обработка выгружает файл проводок,
`OneC\PostingsFile` его читает, `PostingsImporter` сопоставляет счета и
аналитику, показывает предпросмотр и грузит. Проводка в закрытом периоде
помечается и не грузится.

Привязка «счёт 1С → счёт FINDIR» жила отдельной таблицей `onec_account_map`, а
с появлением интеграций переехала в `integration_links` вместе со всеми
остальными соответствиями: таблица для этого одна на все системы (миграция
`2026_09_08_000001_integration_links_as_maps` перенесла строки и убрала старую
таблицу).

**FUSIONPOS (API).** Два импортёра: `WarehouseInvoiceImporter` (приходные
накладные со складов) и `ShiftSalesImporter` (продажи по кассовым сменам).
Соответствия складов, касс и номенклатуры — в `integration_links`.

Общий экран загрузки на все подключённые системы: выбор сущности, периода и
режима, затем предпросмотр и запуск. Каждый запуск пишется в
`integration_runs` со счётчиками `fetched/created/updated/skipped/failed`.

---

## 15. Фонды

Модель распределения (`fund_schemes`) делит входящую выручку между фондами по
процентам; `funds` хранит долю и статьи ДДС, которые в фонд попадают. Акт
финансового планирования (`fund_plan_docs` + строки) — недельный документ: что
по модели причитается и что из этого приняли к оплате. Калькулятор план/факт —
`GET /funds/calc`.

---

## 16. ИИ-помощник

- `OperationDraftService` — текст или файл → черновик операции (счета,
  аналитика, сумма). Работает **под правами того, кто позвал**: закрытый счёт не
  покажет, в закрытый период не внесёт.
- `AnalyticsQueryService` — вопросы по цифрам поверх тех же данных, что отчёты.
- `applyBulk` — массовая правка «с его слов», с журналом и откатом
  (`/ai/bulk-log/{id}/revert`).
- `AiUsage` считает токены и стоимость по каждой функции (`ai_usage`);
  страница «Расход на ИИ» живёт в настройках, а не в разделе помощника.
- Диалоги хранятся по пользователю (`ai_dialogs`).

---

## 17. Массовые правки

**Операции** (`BulkOperationEditor`): `date`, `in_bi_id`, `out_bi_id`,
`project_id`, `content`, `note`, `is_posted` и аналитика по восьми справочникам
со выбором стороны (`any` / `debit` / `credit`). Правила:

- поле меняется только если явно передано: пустое значение у переданного поля
  означает «очистить»;
- `movedDate()` берёт **день из правки, время из операции**: порядок внутри дня
  значим, а массовый перенос про день;
- пропуски с причиной: закрытый период (в том числе целевая дата), операции из
  документов, совпадение дебета с кредитом, отсутствие слота под аналитику,
  «уже с такими значениями»;
- всё действие пишется в `bulk_update_log` с `undo` — откат одной кнопкой.

**Справочники** (`BulkInfoEditor`): `parent_id`, `expense_kind`, `flow_kind`.
Только внутри одного справочника (`commonType()`): родитель из чужого сломал бы
дерево, а вида у контрагента не бывает. Пропуски: перенос под себя и под
собственного потомка. Правка идёт через модель, поэтому попадает в историю
каждой записи.

У обоих редакторов предпросмотр считается автоматически (debounce 350 мс), а
число стоит на кнопке применения — отдельной кнопки «посмотреть» нет намеренно.

---

## 18. Ссылки на элемент справочника (`InfoReferences`)

Отвечает на два вопроса: «можно ли тронуть элемент» и «чем он занят».

- `count()` — место → сколько строк; `lists()` — то же плюс первые 50 строк с
  готовыми подписями и переходом в объект (`GET /info/{id}/references`).
- Места перечислены **явно** (`COLUMNS`, `JSON_LISTS`, `integration_links`):
  угадывание по именам колонок однажды пропустило бы ссылку или придумало
  несуществующую (`cash_id` в бюджете ссылается на справочник, `parent_id` у
  счёта — нет).
- Удалённое ссылкой не считается, в том числе строка удалённого документа
  (`PARENTS`): у записи, которой нет, элемент ничего не держит.
- Счёт и список считает один запрос, поэтому число в заголовке группы всегда
  совпадает с её содержимым. Исключение — закрытые счета: из счёта они не
  вычитаются (ссылка есть), из списка убираются, и группа поднимает
  `restricted` с полем `visible`.
- `balance_changes` здесь сознательно нет: производная от операций.

На этом же сервисе стоит **запрет смены справочника у элемента, на который
ссылаются**: ссылки хранят id, а не тип, поэтому смена ничего не переносит — она
молча меняет смысл записанного.

---

## 19. Архивная копия (`TenantBackupService`)

Один gzip-JSON со всеми данными компании. Устройство — «всё, кроме
исключённого», и исключений ровно два вида: служебное состояние (очереди,
сессии, токены входа, `migrations`) и производное — `balance_changes`, которое
восстановится само, как только вернутся операции. Остальное попадает в копию
без доработки: новая таблица или новое поле входят туда сами.

- История правок (`object_versions`) — по галочке: весит больше всех данных
  вместе, а нужна не в каждой копии.
- Пользователи и должности входят **с паролями** (в хешах): иначе
  восстановление возвращало бы компанию без людей. Файл равен паролю от компании.
- Восстановление **заменяет** данные. `inspect` сначала показывает состав и
  предупреждает, если копия от другой компании.
- `keepActor()` — если в копии нет того, кто её грузит, его учётка сохраняется:
  иначе он восстановил бы компанию и лишился входа.
- Колонки, которых в текущей схеме уже нет, отбрасываются и перечисляются в
  ответе (`dropped`): старая копия восстановится, но молча терять поля нельзя.

---

## 20. Справка в приложении

`front/src/help/*.md` + реестр `index.js`. Тексты лежат в сборке, а не в базе:
справка одинакова для всех тенантов и обязана меняться тем же коммитом, что и
функция, которую описывает. Заголовок и первый абзац берутся из самого файла,
чтобы оглавление не разъезжалось с текстом.

В реестре у статьи перечислены маршруты страниц: кнопка «?» открывает ту
статью, в чьём списке есть текущий путь.

---

## 21. Особенности и нюансы

- `balance_changes.quantity` — со знаком, только для счетов с `has_quantity=1`
- Пассив хранит кредит отрицательным: на этом стоит сходимость баланса
- `table_name/table_id` в `operations` — связь с документом-источником
- `DocumentService::post()` нормализует строки операций до одинакового набора
  ключей (`$baseRow`) перед bulk insert — иначе MySQL ругается
- `CostCalculatorService::getStock()` — остаток одной позиции, для будущих типов
  документов (списание, перемещение, производство)
- Статические маршруты — до динамических `{id}` (см. раздел 8)
- `AccountScope` кэшируется на запрос; тесты и консоль используют
  `AccountScope::unrestricted()`
- Массовые `UPDATE` мимо моделей историю не поднимают — звать `History::record()`
- Фронт: `ObjectOpener` живёт в `Layout` и слушает событие — объект открывается
  там, где стоишь, без ухода на его страницу
- Фронт: компоненты-строки объявляются **на уровне модуля**; объявленная внутри
  родителя строка пересоздаётся на каждом рендере, и поле теряет фокус (а
  календарь закрывается сразу после открытия)

### Эксплуатация

Прод поднят своим compose-файлом `docker-compose.prod.yml`. Два правила, о
которые уже спотыкались:

1. **Не делать `config:cache`.** `TenantService` и `AuthController` читают
   `DB_HOST` через `env()` в рантайме; при кэше `.env` не грузится и тенантные
   подключения ломаются. Держать `config:clear`.
2. **После правки конфига docker-nginx — `up -d --force-recreate nginx`**, а не
   reload: `scp` меняет inode, а bind-mount одиночного файла остаётся на старом.

Плюс: новый маршрут требует `route:cache`, правка PHP — `restart php` (opcache
`validate_timestamps=0`), правка схемы — дампа перед миграцией.

---

## 22. Миграции тенантной БД (хронология)

```
0001_01_01_000000_create_users_table
0001_01_01_000002_create_jobs_table
2024_01_01_000001_create_main_schema                 # основные таблицы + триггеры
2024_01_01_000003_create_personal_access_tokens_table
2026_03_19_000001_add_content_to_operations
2026_03_20_000001_add_outgoing_defaults_to_projects
2026_03_20_000002_create_documents_tables
2026_03_21_000001_create_budget_tables
2026_03_21_000001_rename_note_to_content_in_balance_changes
2026_03_21_000002_add_external_fields_to_documents
2026_03_21_000003_create_settings_table
2026_03_21_000004_add_has_quantity_to_balance_items  # + пересчёт триггеров
2026_03_22_000001_add_turnover_only_to_balance_items
2026_03_24_000001_add_content_to_budget_items
2026_03_28_000001_add_section_to_budget_items
2026_03_29_000001_add_archived_status_to_budget_documents
2026_04_19_000001_add_pdc_type_to_budget_documents   # платёжный календарь
2026_05_30_000001_create_category_postings           # движок автозаполнения
2026_05_30_000002_create_payment_classification_rules
2026_05_31_000001_add_default_expense_id_to_info
2026_06_07_000001_fix_balance_changes_on_soft_delete
2026_06_07_000002_backfill_acquiring_fee_rules
2026_07_24_000001_create_fund_schemes_tables         # фонды
2026_07_24_000002_create_fund_plan_docs
2026_07_24_000003_add_accepted_to_fund_plan_lines
2026_07_27_000001_add_fund_percents_to_fund_plan_docs
2026_08_02_000001_create_operation_templates
2026_08_03_000001_create_bulk_update_log             # откат массовых правок
2026_08_08_120000_create_integrations_tables
2026_08_12_000001_add_is_posted_to_operations
2026_08_16_000001_add_side_to_balance_changes
2026_09_04_000001_create_document_types              # универсальный движок документов
2026_09_04_000002_add_head_override_to_document_items
2026_09_05_000001_rename_clients_account_code
2026_09_05_000002_create_ai_usage
2026_09_06_000001_create_roles_and_user_access       # права по разделам
2026_09_07_000001_add_denied_accounts_to_roles       # закрытые счета
2026_09_07_000001_create_onec_account_map
2026_09_08_000001_integration_links_as_maps
2026_09_09_000001_create_ai_dialogs
2026_09_11_000001_grant_admin_to_users_without_role
2026_09_11_000002_index_operations_date
2026_09_12_000001_analytic_slot_type_set             # слот = набор типов
2026_09_14_000001_create_object_versions             # история правок
2026_09_14_000002_add_created_by_to_operations
2026_09_17_000001_add_kind_to_document_items
2026_09_23_000001_add_is_variable_to_info
2026_09_24_000001_add_department_to_documents
2026_09_25_000001_bdr_structure                      # разрез БДР
2026_09_25_000002_expense_kind                       # is_variable → expense_kind
2026_09_28_000001_flow_kind                          # вид деятельности у статьи ДДС
```

---

## 23. Демо-данные

**Реестр наборов** — `DemoDatasets` (`trade` готов, `manufacturing` и `horeca`
стоят с `ready => false`: в окне они видны серыми, чтобы не читалось «торговля —
всё, на что программа способна»). Набор только описан, работу делает консольная
команда, поэтому генератор один и тот же и из консоли, и из интерфейса.

**Кнопка** — `DemoSeeder` на фронте: набрать слово `demo` вне полей ввода.
`DemoController` заполняет **только чистую базу** (`operations`, `documents`,
`budget_documents` пусты): генератор заводит свои справочники и остатки, и
поверх живого учёта получилась бы вторая компания в одной базе.

**Генератор торговли** — `demo:trading {tenant} {--wipe}`, весь прогон внутри
`History::silently()` (история на три тысячи сгенерированных проводок — шум).
`mt_srand` фиксирован, поэтому пересборка даёт ту же базу до рубля. Что держит
правдоподобие:

- **долги живут задержкой платежа**, а не подгонкой к круглому числу: у каждой
  отгрузки свой срок, дебиторка на конец складывается сама;
- **кредитная линия — заглушка казначейства**: деньги считаются по дням, ниже
  порога выбирается транш, выше потолка гасится, поэтому минуса на счёте не
  бывает;
- **суммовой учёт**: у товарного счёта выключено количество, себестоимость стоит
  прямо в строке (`amount_cost`), средневзвешенный расчёт не включается.

**Платёжный календарь** (два документа `pdc`: декабрь 2026 — утверждён, январь
2027 — черновик) строится не из месячных итогов, а из сроков: ожидаемые
поступления — сроки оплаты отгрузок, выплаты поставщикам — сроки по закупкам,
регулярные платежи стоят на своих числах и сдвигаются с выходных и новогодних
каникул. В январе намеренно оставлен **кассовый разрыв**: по графику банка надо
гасить транш, и календарь показывает дефицит заранее — ровно для этого его и
ведут.

Знак в плане ДДС и календаря — как у факта по кассе: поступления плюсом,
выплаты минусом (`sectionSign` в БДР, а здесь направление знает статья).
