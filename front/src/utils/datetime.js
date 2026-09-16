/**
 * Время, записанное сервером.
 *
 * Пояс приложения — UTC, и `now()` пишет в базу именно его. Браузер же без
 * указания пояса читает «2026-09-14 21:50» как своё местное время, и ночная
 * правка показывалась бы вчерашним вечером — на три часа раньше, чем была.
 *
 * Разбираем как UTC и показываем в поясе того, кто смотрит. Значение с уже
 * проставленным поясом («…Z», «…+03:00») оставляем как есть: сервер постепенно
 * переходит на такой вид, и обе записи должны читаться одинаково.
 *
 * Не годится для дат, которые ввёл человек: дата операции или документа — это
 * календарное число без пояса, и сдвигать его нельзя.
 */
export const parseUtc = (s) => {
  const t = String(s || '').replace(' ', 'T')
  return new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`)
}

/** «14.09.26, 21:50» по местным часам смотрящего */
export const whenUtc = (s) => {
  if (!s) return ''

  const d = parseUtc(s)
  if (isNaN(d)) return String(s)

  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Граница отбора по дате — мгновение со сдвигом пояса.
 *
 * Дата из поля ввода означает местный календарный день. Чтобы сервер отобрал
 * именно его, а не сутки со сдвигом, шлём начало и конец дня вместе с поясом.
 */
export const dayBound = (date, endOfDay = false) => {
  if (!date) return ''

  const [y, m, d] = String(date).split('-').map(Number)
  const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0)
  if (isNaN(dt)) return String(date)

  const pad = (n) => String(n).padStart(2, '0')
  const off = -dt.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'

  return `${y}-${pad(m)}-${pad(d)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}
