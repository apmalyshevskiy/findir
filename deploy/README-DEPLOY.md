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
