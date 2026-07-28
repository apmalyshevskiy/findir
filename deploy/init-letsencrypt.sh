#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  FINDIR — первичный выпуск TLS-сертификата Let's Encrypt
#  Запускать ОДИН раз на сервере из корня репозитория:
#      ./deploy/init-letsencrypt.sh you@example.com
#  Второй аргумент "staging" — тестовый CA (без лимитов, для отладки).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

DOMAIN="findir.161-104-34-180.sslip.io"
EMAIL="${1:-}"
MODE="${2:-prod}"
COMPOSE="docker compose -f docker-compose.prod.yml"
LE_LIVE="/etc/letsencrypt/live/${DOMAIN}"

echo "▶ Домен: ${DOMAIN}"

# 1. Временный self-signed сертификат, чтобы nginx смог стартовать
echo "▶ [1/5] Создаю временный сертификат…"
$COMPOSE run --rm --entrypoint sh certbot -c "
  mkdir -p '${LE_LIVE}' &&
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout '${LE_LIVE}/privkey.pem' \
    -out    '${LE_LIVE}/fullchain.pem' \
    -subj '/CN=${DOMAIN}'"

# 2. Собираем фронт и поднимаем nginx (+ php, redis как зависимости)
echo "▶ [2/5] Сборка фронта и запуск nginx…"
$COMPOSE up -d --build nginx

# 3. Удаляем временный сертификат
echo "▶ [3/5] Удаляю временный сертификат…"
$COMPOSE run --rm --entrypoint sh certbot -c "
  rm -rf /etc/letsencrypt/live/${DOMAIN} \
         /etc/letsencrypt/archive/${DOMAIN} \
         /etc/letsencrypt/renewal/${DOMAIN}.conf"

# 4. Запрашиваем настоящий сертификат через webroot (http-01)
echo "▶ [4/5] Запрашиваю сертификат Let's Encrypt…"
STAGING_ARG=""
[ "$MODE" = "staging" ] && STAGING_ARG="--staging"
if [ -n "$EMAIL" ]; then
  EMAIL_ARG="--email ${EMAIL}"
else
  EMAIL_ARG="--register-unsafely-without-email"
fi

$COMPOSE run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot \
  ${STAGING_ARG} ${EMAIL_ARG} \
  -d "${DOMAIN}" \
  --rsa-key-size 4096 --agree-tos --no-eff-email --force-renewal

# 5. Перезагружаем nginx с настоящим сертификатом
echo "▶ [5/5] Перезагрузка nginx…"
$COMPOSE exec nginx nginx -s reload

echo "✅ Готово. Сертификат выпущен для ${DOMAIN}."
echo "   Теперь поднимите весь стек:  ${COMPOSE} up -d"
