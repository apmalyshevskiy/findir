#!/bin/bash
# Полный дамп всех баз FINDIR: схема, данные и триггеры.
#
# Архивная копия из интерфейса — про данные одной компании и не спасает от
# ошибки уровня «снесли таблицу»: здесь дамп всего сервера, включая central.
#
# Ставится на сервер как /opt/findir/dump-all.sh. Расписание — файлом
# /etc/cron.d/findir-dump (ежедневно в 03:00 по времени сервера):
#   0 3 * * * root /opt/findir/dump-all.sh >> /var/log/findir-dump.log 2>&1
#
# Вывод идёт в журнал, а не в /dev/null: дамп, который молча перестал
# делаться, хуже, чем его отсутствие, — о пропаже узнают в день, когда он нужен.
# Последний удачный запуск отмечается файлом backups/LAST_OK; по его дате
# видно, жив ли бэкап, не читая журнал.
set -euo pipefail

cd /opt/findir
set -a; . ./back/.env; set +a

OUT=/opt/findir/backups
KEEP_DAYS=14
STAMP=$(date +%F-%H%M)

# В дампах данные всех компаний и хеши паролей: читать их должен только root
umask 077
mkdir -p "$OUT"
chmod 700 "$OUT"

# Два запуска разом (расписание и рука) писали бы в одни и те же файлы
exec 9>"$OUT/.lock"
if ! flock -n 9; then
  echo "$(date '+%F %T') уже идёт другой запуск — выхожу"
  exit 1
fi

echo "$(date '+%F %T') начинаю дамп"

# Недописанное с прошлого сбоя не должно ни копиться, ни сходить за дамп
rm -f "$OUT"/*.sql.gz.part

DBS=$(mysql -h 127.0.0.1 -u"$DB_USERNAME" -p"$DB_PASSWORD" -N -e 'SHOW DATABASES LIKE "findir%"')

if [ -z "$DBS" ]; then
  echo "$(date '+%F %T') ОШИБКА: ни одной базы findir* не найдено"
  exit 1
fi

COUNT=0
for DB in $DBS; do
  PART="$OUT/$DB-$STAMP.sql.gz.part"

  # Сначала во временный файл: оборвётся дамп — в каталоге не останется
  # обрубка с именем настоящего дампа, по которому потом попробуют подняться
  mysqldump -h 127.0.0.1 -u"$DB_USERNAME" -p"$DB_PASSWORD" \
    --routines --triggers --single-transaction --quick "$DB" \
    | gzip > "$PART"

  # Архив цел и дописан до конца: mysqldump ставит эту строку последней
  gzip -t "$PART"
  if ! zcat "$PART" | tail -n 1 | grep -q 'Dump completed'; then
    echo "$(date '+%F %T') ОШИБКА: дамп $DB не дописан"
    exit 1
  fi

  mv "$PART" "$OUT/$DB-$STAMP.sql.gz"
  COUNT=$((COUNT + 1))
done

# Старое чистим только после удачного прохода: сломайся дамп на месяц — прежние
# копии останутся лежать, а не будут вычищены по сроку одна за другой.
# Без чистки диск кончится незаметно
find "$OUT" -name 'findir_*.sql.gz' -mtime +$KEEP_DAYS -delete

date '+%F %T' > "$OUT/LAST_OK"
echo "$(date '+%F %T') готово: баз $COUNT, занято $(du -sh "$OUT" | cut -f1)"
