// Работа с периодами отчётов: типовые диапазоны и человеческие подписи.
// Один источник правды для ОСВ, списка операций и всего, что появится дальше.

export const localDate = (date) => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 10)
}

export const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

export const MONTHS_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
]

export const QUARTERS = ['I', 'II', 'III', 'IV']

// Календарные диапазоны: месяц/квартал/год целиком, одним кликом обе даты
export const monthRange   = (y, m) => ({ from: localDate(new Date(y, m, 1)),      to: localDate(new Date(y, m + 1, 0)) })
export const quarterRange = (y, q) => ({ from: localDate(new Date(y, q * 3, 1)),  to: localDate(new Date(y, q * 3 + 3, 0)) })
export const yearRange    = (y)    => ({ from: `${y}-01-01`,                      to: `${y}-12-31` })

/** Пресеты, привязанные к «сегодня»: пересчитываются при каждом открытии приложения. */
export const PRESETS = [
  { key: 'today',   label: 'Сегодня' },
  { key: 'week',    label: 'Неделя' },
  { key: 'month',   label: 'Месяц' },
  { key: 'quarter', label: 'Квартал' },
  { key: 'year',    label: 'Год' },
  { key: 'all',     label: 'Всё время' },
]

export const presetRange = (key, now = new Date()) => {
  const y = now.getFullYear()

  if (key === 'today') {
    const d = localDate(now)
    return { from: d, to: d }
  }
  if (key === 'week') {
    // С понедельника текущей недели по сегодня
    const mon = new Date(now)
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7))
    return { from: localDate(mon), to: localDate(now) }
  }
  if (key === 'month')   return monthRange(y, now.getMonth())
  if (key === 'quarter') return quarterRange(y, Math.floor(now.getMonth() / 3))
  if (key === 'year')    return yearRange(y)
  if (key === 'all')     return { from: '', to: '' }

  return monthRange(y, now.getMonth())
}

const parts = (iso) => {
  const [y, m, d] = (iso || '').split('-').map(Number)
  return Number.isFinite(y) ? { y, m: m - 1, d } : null
}

const ddmmyyyy = (iso) => {
  const p = parts(iso)
  return p ? `${String(p.d).padStart(2, '0')}.${String(p.m + 1).padStart(2, '0')}.${p.y}` : ''
}

/** Совпадает ли диапазон с календарным месяцем / кварталом / годом. */
export const matchesMonth   = (period, y, m) => period.from === monthRange(y, m).from   && period.to === monthRange(y, m).to
export const matchesQuarter = (period, y, q) => period.from === quarterRange(y, q).from && period.to === quarterRange(y, q).to
export const matchesYear    = (period, y)    => period.from === yearRange(y).from       && period.to === yearRange(y).to

/**
 * Подпись периода: «Август 2026», «III квартал 2026», «2026 год»
 * или явный диапазон дат.
 */
export const periodLabel = (period) => {
  const { from, to } = period || {}
  if (!from && !to) return 'Всё время'
  if (!from) return `по ${ddmmyyyy(to)}`
  if (!to)   return `с ${ddmmyyyy(from)}`

  const f = parts(from)
  if (f) {
    if (matchesYear(period, f.y))              return `${f.y} год`
    if (matchesMonth(period, f.y, f.m))        return `${MONTHS[f.m]} ${f.y}`
    const q = Math.floor(f.m / 3)
    if (matchesQuarter(period, f.y, q))        return `${QUARTERS[q]} квартал ${f.y}`
  }

  if (from === to) return ddmmyyyy(from)
  return `${ddmmyyyy(from)} — ${ddmmyyyy(to)}`
}

/** Год, на который логично открыть выбор при текущем периоде. */
export const periodYear = (period) => parts(period?.from)?.y ?? new Date().getFullYear()
