# Описание проекта: FINDIR (Financial Director)

## 1. Архитектура и стек технологий

Проект представляет собой SPA-приложение с разделённым фронтендом и бэкендом в едином (monorepo) репозитории.

- **Frontend:** React, Vite (порт 3000), Tailwind CSS v4
- **Backend:** Laravel 12, PHP 8.3, REST API
- **База данных:** MySQL 8.0 (внешний порт 3307)
- **Кэш и очереди:** Redis + Laravel Horizon
- **Инфраструктура:** Docker Compose
- **Мультитенантность:** stancl/tenancy, кастомная реализация (см. раздел 5)

---

## 2. Структура директорий

```
findir/
├── back/                        # Laravel API
│   ├── app/
│   │   ├── Http/Controllers/Api/V1/
│   │   │   ├── TenantController.php          # базовый: initTenant(), $this->dbName
│   │   │   ├── AuthController.php
│   │   │   ├── OperationsController.php
│   │   │   ├── InfoController.php
│   │   │   ├── BalanceItemsController.php
│   │   │   ├── BalanceSheetController.php
│   │   │   └── BankStatementController.php   # парсинг банковской выписки
│   │   ├── Models/Tenant/
│   │   │   ├── Operation.php
│   │   │   └── Info.php
│   │   └── Services/
│   │       ├── TenantService.php
│   │       ├── ClientBankExchangeParser.php  # парсер формата 1C Win-1251
│   │       └── BankStatementMatcher.php      # автосопоставление по ИНН
│   ├── database/migrations/tenant/           # миграции тенантных БД
│   └── routes/api.php
│
├── front/                       # React SPA
│   └── src/
│       ├── api/
│       │   ├── client.js           # axios + Bearer token + 401 redirect
│       │   ├── operations.js       # CRUD операций
│       │   ├── info.js             # CRUD справочников
│       │   └── bankStatements.js   # парсинг выписки
│       ├── pages/
│       │   ├── LoginPage.jsx
│       │   ├── DashboardPage.jsx       # список операций, фильтры, массовые действия
│       │   ├── InfoPage.jsx            # справочники (дерево, CRUD, ИНН)
│       │   ├── BalanceSheetPage.jsx    # ОСВ с drill-down и экспортом в Excel
│       │   └── BankStatementPage.jsx  # импорт банковской выписки
│       ├── components/
│       │   ├── Layout.jsx
│       │   └── OperationForm.jsx
│       └── App.jsx
│
├── nginx/, php/, mysql/         # конфиги Docker-контейнеров
└── docker-compose.yml
```

---

## 3. Docker-контейнеры

| Контейнер | Назначение | Порт |
|-----------|-----------|------|
| `findir_php` | PHP-FPM, Laravel | — |
| `findir_nginx` | Nginx, API + фронт | 80 |
| `findir_mysql` | MySQL 8.0 | 3307 |
| `findir_redis` | Redis | — |
| `findir_horizon` | Laravel Horizon (очереди) | — |
| `findir_scheduler` | Laravel Scheduler | — |
| `findir_front` | Node/Vite dev-сервер | 3000 |
| `findir_phpmyadmin` | phpMyAdmin | 8080 |
| `findir_redis_ui` | Redis Commander | 8081 |
| `findir_mailpit` | Локальная почта | 8025 |

---

## 4. Ключевые сущности и схема данных

### `info` — справочники (тенантная БД)

```sql
id, parent_id, code VARCHAR(35), name,
type ENUM(partner, employee, department, cash, flow, expenses, product, revenue),
description TEXT,
inn VARCHAR(12),   -- ИНН контрагента/сотрудника (для автосопоставления выписки)
sort_order INT, is_active, timestamps, soft_deletes
```

**Типы справочников:**

| Тип | Назначение | Особенности |
|-----|-----------|-------------|
| `partner` | Контрагенты | Поле `inn` для автосопоставления при импорте выписки |
| `cash` | Кассы / расчётные счета | |
| `flow` | Статьи движения ДДС | Иерархия |
| `expenses` | Статьи расходов | |
| `revenue` | Статьи доходов | |
| `employee` | Сотрудники | Поле `inn` |
| `department` | Отделы | |
| `product` | Товары/Услуги | |

Отображаются в виде сворачиваемого дерева (`parent_id`, `sort_order`).

---

### `balance_items` — план счетов

```sql
id, parent_id, name, code VARCHAR(10),
info_1_type ENUM(...),   -- тип аналитики 1-го уровня
info_2_type ENUM(...),   -- тип аналитики 2-го уровня
info_3_type ENUM(...),
is_system
```

**Ключевые счета:**

| Код | Название | info_1_type | info_2_type |
|-----|---------|------------|------------|
| А100 | ДЕНЕЖНЫЕ СРЕДСТВА | cash | flow |
| А405 | КЛИЕНТЫ | partner | — |
| А410 | АВАНСЫ ПОСТАВЩИКАМ | partner | — |
| П100 | ПОСТАВЩИКИ | partner | — |
| П335 | СОТРУДНИКИ | employee | — |
| П589 | РАСХОДЫ | expenses | — |

---

### `operations` — проводки (двойная запись)

```sql
id, date, project_id, amount, quantity, note,
source VARCHAR(50),         -- 'manual' | 'bank_import'
external_id VARCHAR(25),    -- номер документа из выписки (для поиска дублей)
external_date DATE,         -- дата документа из выписки
in_bi_id,  in_info_1_id,  in_info_2_id,  in_info_3_id,   -- дебет + аналитика
out_bi_id, out_info_1_id, out_info_2_id, out_info_3_id,  -- кредит + аналитика
timestamps, soft_deletes
```

**Логика двойной записи для банковских операций (А100):**

| Направление | Дт (in) | Кт (out) |
|-------------|---------|---------|
| Приход | А100, info_1=cash, info_2=flow | Счёт контрагента + его аналитика |
| Расход | Счёт контрагента + его аналитика | А100, info_1=cash, info_2=flow |

---

### `projects`

```sql
id, parent_id, name, currency CHAR(3), timezone, timestamps, soft_deletes
```

---

## 5. Мультитенантность

**Кастомная, не стандартный stancl/tenancy pipeline.**

- Центральная БД: `findir_central` — пользователи, тенанты, регистрация
- Тенантные БД: `findir_{slug}` — все данные клиента
- При каждом запросе фронт передаёт заголовок `X-Tenant: {slug}`
- `TenantController::initTenant()` вызывает `TenantService::connect($slug)` — переключает соединение Laravel на нужную БД через `$this->dbName`

**Команда `tenants:migrate` не работает** — не задан `central_connection` в `tenancy.php`.

**Применение миграций тенанта вручную:**
```bash
docker exec -it findir_php bash
php artisan tinker

\App\Services\TenantService::connect('ooo-lbrmts');
Artisan::call('migrate', [
    '--database' => 'findir_ooo_lbrmts',
    '--path'     => 'database/migrations/tenant',
    '--force'    => true
]);
echo Artisan::output();
```

**Рабочий тенант для тестирования:** `ooo-lbrmts` → БД `findir_ooo_lbrmts`

---

## 6. API эндпоинты

Все под префиксом `/api/v1/`. Auth: Bearer token (Laravel Sanctum). Тенант: заголовок `X-Tenant`.

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/login` | Логин |
| POST | `/register` | Регистрация |
| GET | `/me` | Текущий пользователь |
| POST | `/logout` | Выход |
| GET | `/operations` | Список операций |
| POST | `/operations` | Создать |
| PUT | `/operations/{id}` | Обновить |
| DELETE | `/operations/{id}` | Удалить |
| GET | `/balance-items` | Список счетов плана |
| GET | `/balance-sheet` | ОСВ |
| GET | `/info` | Справочник |
| POST | `/info` | Создать запись |
| PUT | `/info/{id}` | Обновить |
| DELETE | `/info/{id}` | Удалить |
| POST | `/bank-statements/parse` | Парсинг файла выписки (multipart) |

**Фильтры GET `/operations`:**
- `date_from`, `date_to`, `project_id`
- `in_bi_id`, `out_bi_id`
- `info_id` — по элементу аналитики (любое поле info)
- `ids` — несколько ID через запятую: `ids=1,2,3`
- `source`, `external_id`, `external_date`
- `per_page`, `page`

---

## 7. Импорт банковской выписки (1C ClientBankExchange)

**Формат файла:** Win-1251, блоки `СекцияДокумент`.

**Парсер** (`ClientBankExchangeParser`): извлекает из каждого блока:
- `ДатаДок`, `НомерДок`, `ДокВид` → `doc_date`, `doc_number`, `doc_type`
- `Сумма` + `ДатаСписано`/`ДатаПоступило` → `amount`, `direction: in/out`
- `ПолучательИНН` / `ПлательщикИНН` → `counterparty_inn`
- `Получатель` / `Плательщик` → `counterparty_raw`
- `НазначениеПлатежа` → `purpose_raw`
- `external_id` = НомерДок, `external_date` = ДатаДок

**Матчер** (`BankStatementMatcher`): автосопоставление при парсинге:
- `suggested_partner_id` — ищет в `info.type=partner` по `inn`
- `suggested_flow_id` — подбирает статью ДДС по ключевым словам из назначения платежа
- `existing_operation_ids` — поиск дублей по `external_id` + `external_date`

**Фронтенд** (`BankStatementPage.jsx`):
- Загрузка файла через drag-and-drop или кнопку
- Каждая строка выписки — карточка с разметкой: направление, сумма, контрагент, назначение
- Статусы строк: «Не размечено» (amber) / «✓ Готово» (green) / «🔗 Создано» (green) / «Пропущено»
- Аналитика подбирается динамически по `info_1_type`/`info_2_type` выбранного корреспондирующего счёта
- Автоподбор контрагента по ИНН из выписки при выборе счёта с `info_1_type=partner`
- Дропдауны аналитики — через `createPortal` (не обрезаются `overflow:hidden`)
- Кнопка «Разбить» — одна строка → несколько операций с суммой
- Кнопка «✎ Изменить» для уже загруженных строк — загружает данные операции из API и открывает форму
- Кнопка «↻ Сохранить изменения» — обновляет существующие операции через `PUT` без удаления
- Кнопка «Отмена» — восстанавливает форму к состоянию на момент открытия

---

## 8. Особенности интерфейса

- **Кастомные дропдауны** (`InfoSelect`, `SearchableInfoSelect`) с поиском и визуальными отступами дерева. В `BankStatementPage` рендерятся через `createPortal` в `document.body` чтобы не обрезаться родительскими `overflow:hidden`
- **Сворачиваемое дерево** в справочниках (`parent_id`, `expandedByType`)
- **Массовые действия** в дашборде — пакетное копирование выделенных операций
- **ОСВ** (`BalanceSheetPage`) — рекурсивный подсчёт сумм для папок-родителей (снизу вверх), drill-down в операции, экспорт в Excel
- **ИНН в справочниках** — поле `inn` отображается в таблице и форме для типов `partner` и `employee`

---

## 9. Фронтенд: API-клиент

`front/src/api/client.js` — axios с:
- `baseURL: '/api/v1'`
- Автоматический `Authorization: Bearer {token}` из localStorage
- Перехват 401 → редирект на `/login`, очистка `token`/`tenant`/`user`

`front/src/api/operations.js`:
```js
getOperations(params)
createOperation(data)
updateOperation(id, data)
deleteOperation(id)
getBalanceItems()
getBalanceSheet(params)
```

---

## 10. Известные ограничения и нюансы

- `tenants:migrate` не работает — применять миграции только через `tinker` (см. раздел 5)
- Поле `inn` добавлено в таблицу `info` миграцией `2026_03_07_000001_add_bank_import_fields.php` (также добавлены `external_id`, `external_date` в `operations`)
- В тенанте `ooo-lbrmts` поля `external_id` и `external_date` уже существовали до миграции — при повторном применении будет ошибка "Column already exists"
- `source='bank_import'` — признак что операция создана из выписки
- Все `balance_items` — системные (`is_system=1`), не редактируются пользователем
