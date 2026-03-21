# Описание проекта: FINDIR (Financial Director)

## 1. Архитектура и стек технологий

- **Frontend:** React, Vite (порт 3000), Tailwind CSS v4
- **Backend:** Laravel 12, PHP 8.3, REST API
- **База данных:** MySQL 8.0 (внешний порт 3307)
- **Кэш и очереди:** Redis + Laravel Horizon
- **Инфраструктура:** Docker Compose
- **Мультитенантность:** кастомная реализация (см. раздел 5)

---

## 2. Структура директорий

```
findir/
├── back/
│   ├── app/Http/Controllers/Api/V1/
│   │   ├── TenantController.php          # базовый: initTenant(), $this->dbName
│   │   ├── AuthController.php
│   │   ├── OperationsController.php      # запрет ред/удал операций из документов
│   │   ├── InfoController.php
│   │   ├── BalanceItemsController.php
│   │   ├── BalanceSheetController.php    # ОСВ с мульти-аналитикой и иерархией
│   │   ├── BankStatementController.php
│   │   ├── ProjectsController.php        # GET /projects
│   │   ├── DocumentsController.php
│   │   └── CostController.php            # POST /documents/calculate-cost
│   ├── app/Models/Tenant/
│   │   ├── Operation.php
│   │   ├── Info.php
│   │   ├── BalanceItem.php
│   │   ├── Document.php
│   │   └── DocumentItem.php
│   ├── app/Services/
│   │   ├── TenantService.php
│   │   ├── ClientBankExchangeParser.php
│   │   ├── BankStatementMatcher.php
│   │   └── Documents/
│   │       ├── DocumentStrategyInterface.php
│   │       ├── DocumentService.php
│   │       ├── CostCalculatorService.php     # расчёт себестоимости (средневзвеш.)
│   │       ├── IncomingInvoiceStrategy.php
│   │       └── OutgoingInvoiceStrategy.php
│   ├── database/migrations/tenant/
│   └── routes/api.php
│
├── front/src/
│   ├── api/
│   │   ├── client.js          # axios + Bearer + 401 redirect
│   │   ├── operations.js
│   │   ├── info.js
│   │   ├── bankStatements.js
│   │   └── documents.js
│   ├── pages/
│   │   ├── LoginPage.jsx
│   │   ├── DashboardPage.jsx       # операции, переход в документ по table_id
│   │   ├── InfoPage.jsx
│   │   ├── BalanceSheetPage.jsx    # ОСВ с мульти-аналитикой, иерархией, drill-down
│   │   ├── BankStatementPage.jsx
│   │   └── DocumentsPage.jsx       # документы: приходные/расходные накладные
│   ├── components/
│   │   ├── Layout.jsx
│   │   └── OperationForm.jsx
│   └── App.jsx
└── docker-compose.yml
```

---

## 3. Docker-контейнеры

| Контейнер | Назначение | Порт |
|-----------|-----------|------|
| `findir_php` | PHP-FPM, Laravel | — |
| `findir_nginx` | Nginx | 80 |
| `findir_mysql` | MySQL 8.0 | 3307 |
| `findir_redis` | Redis | — |
| `findir_horizon` | Laravel Horizon | — |
| `findir_scheduler` | Laravel Scheduler | — |
| `findir_front` | Node/Vite | 3000 |
| `findir_phpmyadmin` | phpMyAdmin | 8080 |
| `findir_redis_ui` | Redis Commander | 8081 |
| `findir_mailpit` | Локальная почта | 8025 |

---

## 4. Ключевые сущности и схема данных

### `info` — справочники

```sql
id, parent_id, code VARCHAR(35), name,
type ENUM(partner, employee, department, cash, flow, expenses, product, revenue),
description TEXT, inn VARCHAR(12), sort_order INT, is_active, timestamps, soft_deletes
```

### `balance_items` — план счетов

```sql
id, parent_id, name, code VARCHAR(10),
info_1_type ENUM(...), info_2_type ENUM(...), info_3_type ENUM(...),
is_system, has_quantity BOOLEAN   -- признак количественного учёта
```

**Ключевые счета:**

| Код | Название | info_1_type | info_2_type | has_quantity |
|-----|---------|------------|------------|-------------|
| А100 | ДЕНЕЖНЫЕ СРЕДСТВА | cash | flow | 0 |
| А200 | ТОВАРЫ | product | department | 1 |
| А230 | МАТЕРИАЛЫ ДЛЯ ПРОИЗВОДСТВА | product | — | 1 |
| А240 | ПРОДУКТЫ | product | — | 1 |
| А405 | КЛИЕНТЫ | partner | — | 0 |
| П100 | ПОСТАВЩИКИ | partner | — | 0 |
| П587 | ДОХОДЫ | revenue | product | 0 |
| П588 | СЕБЕСТОИМОСТЬ | revenue | product | 0 |
| П589 | РАСХОДЫ | expenses | — | 0 |

### `operations` — проводки (двойная запись)

```sql
id, date TIMESTAMP, project_id, amount, quantity,
note, content,
source VARCHAR(50),        -- 'manual' | 'bank_import' | 'document'
table_name VARCHAR(50),    -- 'documents' если создана из документа
table_id VARCHAR(36),      -- documents.id
external_id, external_date,
in_bi_id, in_info_1_id, in_info_2_id, in_info_3_id, in_quantity,
out_bi_id, out_info_1_id, out_info_2_id, out_info_3_id, out_quantity,
timestamps, soft_deletes
```

**Важно:** операции с `table_name='documents'` нельзя редактировать/удалять через API — возвращается 422.

### `balance_changes` — журнал изменений (заполняется триггерами)

```sql
operation_id, date, project_id, amount, quantity,
bi_id, info_1_id, info_2_id, info_3_id,
content TEXT
```

**Логика quantity в триггерах:**
- Пишется только для счетов с `has_quantity=1` (А200, А230, А240)
- Дт строка (amount > 0): `+in_quantity`
- Кт строка (amount < 0): `-out_quantity`
- Знак quantity совпадает со знаком amount

### `settings` — настройки тенанта

```sql
key VARCHAR(100) PK, value TEXT, timestamps
```

Используется для хранения `balance_actual_date` — даты до которой таблица `balance` содержит агрегированные остатки (пока не заполняется).

### `projects`

```sql
id, parent_id, name, currency CHAR(3), timezone,
outgoing_revenue_bi_id,    -- FK → balance_items (П587)
outgoing_cogs_bi_id,       -- FK → balance_items (П588)
outgoing_revenue_item_id,  -- FK → info(revenue)
timestamps, soft_deletes
```

### `documents` — шапка документа

```sql
id,
date DATETIME,
number VARCHAR(50),           -- внутренний номер
external_number VARCHAR(100), -- из внешней программы (1С)
external_date DATE,
project_id,
type ENUM(incoming_invoice, outgoing_invoice),
status ENUM(draft, posted),
created_by FK → users,
bi_id, info_1_id, info_2_id, info_3_id,
revenue_bi_id, cogs_bi_id, revenue_item_id,  -- только outgoing_invoice
amount DECIMAL(15,2), amount_vat DECIMAL(15,2),
content TEXT, note TEXT, extra JSON,
timestamps, soft_deletes
```

**Статусы:**
- `draft` — «Не проведён», редактируется
- `posted` — «Проведён», только просмотр и отмена
- `cancelled` — «Отменён», зарезервирован

**Отмена проведения** переводит в `draft`.

### `document_items` — строки документа

```sql
id, document_id FK CASCADE, sort_order,
bi_id, info_1_id, info_2_id, info_3_id,
quantity DECIMAL(15,3), price DECIMAL(15,4),
amount DECIMAL(15,2), amount_vat DECIMAL(15,2),
amount_cost DECIMAL(15,2),   -- себестоимость, только outgoing_invoice
content TEXT, note TEXT, timestamps
```

---

## 5. Мультитенантность

**Кастомная, не stancl/tenancy pipeline.**

- Центральная БД: `findir_central` — пользователи, тенанты
- Тенантные БД: `findir_{slug}`
- Заголовок: `X-Tenant: {slug}`
- `TenantController::initTenant()` → `TenantService::connect($slug)` → `$this->dbName`

**Применение миграций:**
```bash
docker exec -it findir_php php artisan tenants:migrate
docker exec -it findir_php php artisan tenants:migrate --tenant=ooo-lbrmts
docker exec -it findir_php php artisan tenants:migrate --tenant=ooo-lbrmts --fresh --seed --force
```

**Рабочий тенант:** `ooo-lbrmts` → БД `findir_ooo_lbrmts`

---

## 6. API эндпоинты

Префикс `/api/v1/`. Auth: Bearer token. Тенант: `X-Tenant`.

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/login` | Логин |
| POST | `/register` | Регистрация |
| GET | `/me` | Текущий пользователь |
| POST | `/logout` | Выход |
| GET | `/projects` | Список проектов |
| GET | `/operations` | Список операций |
| POST | `/operations` | Создать |
| PUT | `/operations/{id}` | Обновить (запрет если source=document) |
| DELETE | `/operations/{id}` | Удалить (запрет если source=document) |
| GET | `/balance-items` | Счета плана |
| GET | `/balance-sheet` | ОСВ |
| GET | `/info` | Справочник |
| POST | `/info` | Создать |
| PUT | `/info/{id}` | Обновить |
| DELETE | `/info/{id}` | Удалить |
| POST | `/bank-statements/parse` | Парсинг выписки |
| GET | `/documents` | Список документов |
| POST | `/documents` | Создать документ |
| GET | `/documents/{id}` | Документ со строками |
| PUT | `/documents/{id}` | Обновить (только draft) |
| DELETE | `/documents/{id}` | Удалить |
| POST | `/documents/calculate-cost` | Рассчитать себестоимость |
| POST | `/documents/{id}/post` | Провести |
| POST | `/documents/{id}/cancel` | Отменить → draft |

**Фильтры GET `/balance-sheet`:**
- `date_from`, `date_to`, `bi_id`, `project_id`
- `info_types[]` — массив типов аналитик в нужном порядке
- `hierarchy_types[]` — типы для которых строится иерархия справочника

**Фильтры GET `/operations`:** `date_from`, `date_to`, `project_id`, `in_bi_id`, `out_bi_id`, `info_id`, `ids`, `source`, `per_page`, `page`

**Фильтры GET `/documents`:** `type`, `status`, `project_id`, `date_from`, `date_to`, `per_page`, `page`

---

## 7. Система документов

### Принцип работы

Документ = шапка (`documents`) + строки (`document_items`). При проведении стратегия создаёт операции с `source='document', table_name='documents', table_id=id`. При повторном проведении старые операции hard-delete, новые создаются.

**Кнопка «✓ Провести»** сначала сохраняет форму (`PUT`/`POST`), затем вызывает `/post` — гарантирует что себестоимость и все поля сохранены до проведения.

### Логика проводок — приходная накладная

```
Дт  item.bi_id (А200/А230) / номенклатура / склад   +qty
Кт  doc.bi_id  (П100)      / поставщик               0
Сумма: item.amount
```

### Логика проводок — расходная накладная

**Операция №1 — Выручка:**
```
Дт  doc.bi_id (А405)          / покупатель             0
Кт  doc.revenue_bi_id (П587)  / статья дохода / номенклатура   0
Сумма: item.amount
```

**Операция №2 — Себестоимость** (если `amount_cost > 0`):
```
Дт  doc.cogs_bi_id (П588)     / статья дохода / номенклатура   0
Кт  item.bi_id (А200/А240)    / номенклатура / склад           -qty
Сумма: item.amount_cost
```

### Расчёт себестоимости (`CostCalculatorService`)

Метод средневзвешенной цены на дату документа (строго `< doc.date`).

1. Проверяет `settings.balance_actual_date` — если есть, берёт opening из `balance` + дельту из `balance_changes` после этой даты
2. Если нет — считает только из `balance_changes` от начала времён
3. `цена = sum(amount) / sum(quantity)` по (bi_id, info_1_id, info_2_id, info_3_id)
4. `amount_cost = min(qty_строки, qty_остатка) * цена` или вся сумма остатка
5. При нулевом/отрицательном остатке — `amount_cost = 0`, флаг `negative_stock = true`

Используется: при проведении (бэкенд) и из формы (кнопка «⚡ Рассчитать», автоматически при выборе номенклатуры).

### Переход в документ из других страниц

- Операции с `table_name='documents'` показывают `📄 → документ` вместо ✎/×
- URL: `navigate('/documents?open={table_id}')`
- `DocumentsPage` читает `?open=ID`, загружает документ, открывает форму нужной вкладки

### Дефолтные счета при создании нового документа

| Тип | Счёт шапки | Счёт строки | Доходы | Себестоимость |
|-----|-----------|------------|--------|--------------|
| incoming_invoice | П100 | А200 | — | — |
| outgoing_invoice | А405 | А200 | П587 | П588 |

---

## 8. ОСВ (BalanceSheetController + BalanceSheetPage)

### Параметры запроса

```
date_from, date_to
bi_id           — фильтр по счёту
project_id      — фильтр по проекту
info_types[]    — типы аналитик в нужном порядке, например: product, department
hierarchy_types[] — для каких типов строить иерархию справочника
```

### Алгоритм бэкенда

1. Загружает `balance_changes` за период (сальдо начальное + обороты)
2. Для каждого счёта строит дерево аналитик через `buildChildren` / `buildInfoHierarchy`
3. `buildInfoHierarchy` — рекурсивный обход дерева справочника (parent_id), суммирование по всем потомкам
4. Если тип не в `hierarchy_types[]` — все `parent_id` принудительно `null` → плоский список

### Интерфейс (BalanceSheetPage)

**Строка фильтров 1:** период (Месяц/Квартал/Год) + даты + кнопка `⋯`

**Кнопка `⋯`** открывает панель: проект (скрыт если один) + счёт + сброс. Первый проект выбирается по умолчанию.

**Строка фильтров 2:** мультиселект аналитик — кнопки-пилюли, клик включает/выключает, показывается порядковый номер

**Строка фильтров 3** (при выбранных аналитиках): пилюли с drag-and-drop для порядка + тогл `≡/⊞` для иерархии каждой аналитики

**Drill-down:** клик на сумму открывает модал с операциями. Операции из документов показывают `📄` вместо ✎.

**Экспорт в Excel:** рекурсивный обход дерева аналитик.

---

## 9. Импорт банковской выписки

**Формат:** Win-1251, 1C ClientBankExchange.

**Парсер** (`ClientBankExchangeParser`): `ДатаДок`, `НомерДок` → `external_id`, `external_date`; ИНН → `counterparty_inn`; назначение → `purpose_raw`.

**Матчер** (`BankStatementMatcher`): автоподбор партнёра по ИНН, статьи ДДС по ключевым словам, поиск дублей.

---

## 10. Интерфейс документов (DocumentsPage)

- Два таба: Приходные / Расходные накладные
- Список: `#id`, дата+время, сумма для любого статуса
- **Форма:** компактная табличная часть — одна строка на позицию, кнопка `···` раскрывает счёт/склад/примечание
- **Числа:** `NumInput` с триадами (при фокусе — чистое число, при blur — форматированное)
- **Дата:** `datetime-local`, внутренний номер + внешний номер/дата
- **Кнопки формы:**
  - Черновик: `Отмена` + `Сохранить` + `✓ Провести`
  - Проведён: `↩ Отменить проведение` + `Закрыть`
- **«Провести»** сначала сохраняет форму, потом проводит
- **Себестоимость:** кнопка `⚡ Рассчитать`, автоматически при выборе номенклатуры/количества

---

## 11. Особенности и нюансы

- `balance_changes.quantity` хранится со знаком (+приход, -расход), только для счетов с `has_quantity=1`
- П587 и П588: `info_1_type='revenue', info_2_type='product'` (изменено вручную в БД и сидере)
- `table_name/table_id` в operations — связь с документом-источником
- `DocumentService::post()` нормализует все строки операций до одинакового набора ключей через `$baseRow` перед bulk insert — обязательно для корректной работы MySQL
- `CostCalculatorService::getStock()` — shortcut для получения остатка одной позиции (для будущих типов документов: Списание, Перемещение, Производство)
- Маршрут `POST /documents/calculate-cost` должен стоять **перед** `POST /documents/{id}/post` в `api.php` — иначе Laravel матчит `calculate-cost` как `{id}`

---

## 12. Миграции тенантной БД (хронология)

```
0001_01_01_000000_create_users_table.php
0001_01_01_000002_create_jobs_table.php
2024_01_01_000001_create_main_schema.php        # основные таблицы + триггеры
2024_01_01_000003_create_personal_access_tokens_table.php
2026_03_07_000001_add_bank_import_fields.php    # inn, external_id, external_date
2026_03_19_000001_add_content_to_operations.php
2026_03_20_000001_add_outgoing_defaults_to_projects.php
2026_03_20_000002_create_documents_tables.php   # documents + document_items
2026_03_21_000001_rename_note_to_content_in_balance_changes.php
2026_03_21_000002_add_external_fields_to_documents.php  # external_number, external_date, date→datetime
2026_03_21_000003_create_settings_table.php     # balance_actual_date
2026_03_21_000004_add_has_quantity_to_balance_items.php  # has_quantity + пересчёт триггеров
```
