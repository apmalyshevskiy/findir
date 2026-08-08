#!/bin/bash
# Полный дамп всех баз FINDIR: схема, данные и триггеры.
#
# Архивная копия из интерфейса — про данные одной компании и не спасает от
# ошибки уровня «снесли таблицу»: здесь дамп всего сервера, включая central.
#
# Ставится на сервер как /opt/findir/dump-all.sh; для ежедневного запуска:
#   0 3 * * * /opt/findir/dump-all.sh >/dev/null 2>&1
set -euo pipefail

cd /opt/findir
set -a; . ./back/.env; set +a

OUT=/opt/findir/backups
KEEP_DAYS=14
mkdir -p "$OUT"
STAMP=$(date +%F-%H%M)

DBS=$(mysql -h 127.0.0.1 -u"$DB_USERNAME" -p"$DB_PASSWORD" -N -e 'SHOW DATABASES LIKE "findir%"')

for DB in $DBS; do
  mysqldump -h 127.0.0.1 -u"$DB_USERNAME" -p"$DB_PASSWORD" \
    --routines --triggers --single-transaction --quick "$DB" \
    | gzip > "$OUT/$DB-$STAMP.sql.gz"
done

# Чистим старое, иначе диск на 2 ГБ кончится незаметно
find "$OUT" -name 'findir_*.sql.gz' -mtime +$KEEP_DAYS -delete

ls -lh "$OUT"
