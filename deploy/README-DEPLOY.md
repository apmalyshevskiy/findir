# FINDIR — прод-деплой (развёрнуто)

**URL:** https://findir.161-104-34-180.sslip.io
**Сервер:** Ubuntu 24.04, 2 ГБ RAM (без swap), root@161.104.34.180, каталог `/opt/findir`.

## Фактическая архитектура

FINDIR встроен рядом с уже работающим сайтом доставки, а не поднимает свой 80/443:

```
  host-nginx (systemd, TLS через certbot)
    161-104-34-180.sslip.io        → 127.0.0.1:8080  (сайт доставки, /opt/fp_site)
    findir.161-104-34-180.sslip.io → 127.0.0.1:8090  (docker-nginx FINDIR, HTTP)
                                          │
   FINDIR compose (/opt/findir/docker-compose.prod.yml):
     nginx(127.0.0.1:8090) + php-fpm + redis + horizon + scheduler
                                          │
   docker0-шлюз 172.17.0.1:3306 → хостовая MariaDB 10.11 (systemd, НЕ docker)
     пользователь findir, базы findir_central + findir_<tenant> (создаются при регистрации)
     bind 0.0.0.0, 3306 закрыт iptables (кроме 127.x и 172.16.0.0/12)
```
> Сайт доставки использует свою отдельную БД — контейнер `fp_site-db-1`. FINDIR с ним больше не связан.
> Внешний доступ к БД FINDIR: `ssh -L 3307:127.0.0.1:3306 findir-server`, затем клиент на `127.0.0.1:3307`.

- **TLS:** host-certbot, сертификат `/etc/letsencrypt/live/findir.161-104-34-180.sslip.io/`, автопродление настроено. Сайт-файл: `/etc/nginx/sites-available/findir.conf` (+symlink). Конфиг доставки `fp_site.conf` не тронут.
- **Секреты:** `back/.env` на сервере (APP_KEY, пароль БД `findir` — сгенерированы на сервере, в репозиторий не попадают).
- **БД-грант:** `` GRANT ALL ON `findir\_%`.* `` даёт пользователю право авто-создавать базы тенантов.

## ⚠️ Два операционных правила (иначе сломается)

1. **НЕ кэшировать конфиг Laravel.** Код (`TenantService`, `AuthController`) читает `DB_HOST` через `env()` в рантайме; при `config:cache` `.env` не загружается и тенантные подключения уходят на неверный хост. Держим конфиг НЕкэшированным (`php artisan config:clear`). `route:cache` — можно.
2. **После правки docker-nginx конфига — `--force-recreate`, а не reload/restart.** `scp` меняет inode файла, а bind-mount одиночного файла остаётся на старом inode; reload/restart читают старую версию. Только пересоздание контейнера подхватывает новый конфиг.

## Передеплой (обновление кода)

С Windows-машины (алиас `findir-server` в `~/.ssh/config`):

```powershell
# 1. Залить изменённый код (пример — один файл или весь back/front)
scp <файл> findir-server:/opt/findir/<путь>

# 2. Если менялся PHP-код — перезапустить (opcache validate_timestamps=0!)
ssh findir-server "cd /opt/findir && docker compose -f docker-compose.prod.yml restart php horizon"

# 2a. Если добавлялись МАРШРУТЫ — иначе новый эндпоинт отдаёт 404: роуты на проде кэшированы
ssh findir-server "cd /opt/findir && docker compose -f docker-compose.prod.yml run --rm php php artisan route:cache && docker compose -f docker-compose.prod.yml restart php"

# 3. Если менялся фронт — пересобрать
ssh findir-server "cd /opt/findir && docker compose -f docker-compose.prod.yml run --rm frontend-build && docker compose -f docker-compose.prod.yml restart nginx"

# 4. Если менялся nginx/conf.d — force-recreate
ssh findir-server "cd /opt/findir && docker compose -f docker-compose.prod.yml up -d --force-recreate nginx"

# 5. Новые миграции central
ssh findir-server "cd /opt/findir && docker compose -f docker-compose.prod.yml run --rm php php artisan migrate --force"
# тенантные: docker compose ... run --rm php php artisan tenants:migrate --force
```

## Полезные команды

```bash
cd /opt/findir
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f php
curl -s https://findir.161-104-34-180.sslip.io/api/v1/health

# БД (root-пароль fp_site-db-1 — в env контейнера):
docker exec fp_site-db-1 mariadb -uroot -p<pw> -e "SELECT id,name,plan FROM findir_central.tenants;"
```

## Первичная установка (как разворачивали, для воспроизведения)

1. `back/.env` из `deploy/env.prod.example` (DB_HOST=fp_site-db-1, пароль сгенерён на сервере).
2. Пользователь+база в общей MariaDB (см. `deploy/db-init.sql`, host `'%'`, грант на `findir\_%`).
3. `chown -R 1000:1000 back/storage back/bootstrap/cache back/.env` (контейнер под uid 1000).
4. `docker compose -f docker-compose.prod.yml build php`
5. `... run --rm php composer install --no-dev --optimize-autoloader`
6. `... run --rm --no-deps php php artisan key:generate --force`
7. `... run --rm php php artisan migrate --force` (central)
8. `... run --rm php php artisan storage:link` + `route:cache` (НЕ config:cache!)
9. `... run --rm frontend-build` (сборка SPA в volume web_build)
10. `... up -d`
11. host-nginx: `deploy/host-nginx-findir.conf` → `/etc/nginx/sites-available/findir.conf` + symlink, `nginx -t && systemctl reload nginx`
12. `certbot --nginx -d findir.161-104-34-180.sslip.io --redirect`

## Замечания

- **2 ГБ RAM без swap** — сборка фронта проходит (`NODE_OPTIONS=--max-old-space-size=768`), но при добавлении сервисов держите запас. Можно позже добавить swap.
- Сайт доставки — отдельный проект `/opt/fp_site`, разворачивается независимо.

## Резервные копии базы

Каждый день в 03:00 по времени сервера (UTC) `deploy/dump-all.sh` снимает все базы `findir*` — central и каждую компанию — в `/opt/findir/backups`, по файлу на базу. Хранится 14 дней. Расписание — `/etc/cron.d/findir-dump`, журнал — `/var/log/findir-dump.log`.

**Жив ли бэкап** — одной командой, не читая журнал:

```bash
ssh findir-server "cat /opt/findir/backups/LAST_OK; tail -3 /var/log/findir-dump.log"
```

`LAST_OK` — время последнего удачного прохода. Старше суток — бэкап не делается, причина в журнале. Старые копии при сбое не вычищаются: чистка идёт только после удачного дампа.

**Подняться из копии** (пример — компания `mw`). Сначала во временную базу, чтобы посмотреть, что внутри, и не затереть рабочую:

```bash
cd /opt/findir && set -a && . ./back/.env && set +a
mysql -h 127.0.0.1 -u"$DB_USERNAME" -p"$DB_PASSWORD" -e 'CREATE DATABASE findir_zz_check'
zcat backups/findir_mw-ГГГГ-ММ-ДД-ЧЧММ.sql.gz | mysql -h 127.0.0.1 -u"$DB_USERNAME" -p"$DB_PASSWORD" findir_zz_check
```

Убедившись, что это нужная копия, — тем же `zcat … | mysql …` в саму `findir_mw` (дамп пересоздаёт таблицы) и `DROP DATABASE findir_zz_check`. Временную базу не оставлять: имя на `findir` попадёт в следующий дамп.

**Чего этот бэкап не закрывает:** копии лежат на том же диске, что и база. От ошибки в данных и снесённой таблицы они спасают, от потери сервера — нет. Для этого их нужно дублировать за пределы сервера.

## Права на файлы

С 15.11.2026 в `/opt/findir` никто, кроме владельца, не пишет. Код принадлежит root, а PHP-контейнеры (`php`, `horizon`, `scheduler` — пользователь `www`, uid 1000) пишут только в своё: `back/storage`, `back/bootstrap/cache` и `back/vendor`. Остальное для приложения доступно только на чтение — взломанный PHP не перепишет код. `back/.env` — режим 600, владелец uid 1000 (его читает контейнер), `.env.bak.*` — 600, root.

- **Залитый через scp файл** получает владельца root и права 644 — контейнер его читает, этого достаточно.
- **Архив распаковывать с `--no-same-owner`:** `tar -xf x.tar --no-same-owner`. Иначе tar под root переносит владельца с машины, где архив собран. Так в `/opt/findir` однажды оказались файлы пользователя с uid 197610 — это учётка Windows из Git Bash.
- **Если приложение пишет `Permission denied`** — проверить, что каталог внутри `back/storage` принадлежит uid 1000. Создавать такие каталоги от имени контейнера: `docker exec findir_php mkdir -p storage/…`.
- **Права до этой правки** сохранены в `/root/findir-rollback/perms-20261115.tsv` (режим, uid, gid, путь). Вернуть их:
  `cd /opt/findir && while IFS=$'\t' read m u g p; do chmod "$m" "$p"; chown "$u:$g" "$p"; done < /root/findir-rollback/perms-20261115.tsv`
