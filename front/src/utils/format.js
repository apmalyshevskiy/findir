/**
 * Деньги и даты — одним способом на всё приложение.
 *
 * Свой `fmt` или `money` был почти на каждой странице, всего около тридцати, и
 * правила у них расходились: где-то копейки есть, где-то нет, ноль выводился и
 * как «0 ₽», и как «—», и как пустая ячейка. В соседних отчётах одна и та же
 * сумма выглядела по-разному, и сверять их глазами было труднее, чем должно.
 */

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Сумма. По умолчанию — с копейками и знаком рубля, как в первичке.
 *
 *   money(1500)                        → «1 500,00 ₽»
 *   money(1500, { kopecks: false })    → «1 500 ₽»      (отчёты и планы)
 *   money(1500, { sign: false })       → «1 500,00»     (колонка, где ₽ в шапке)
 *   money(0, { zero: '—' })            → «—»            (таблица, где нули шумят)
 */
export function money(v, { kopecks = true, sign = true, zero, empty = '' } = {}) {
  const n = num(v)
  if (n == null) return empty
  if (n === 0 && zero !== undefined) return zero
  // Минус — настоящий, а не дефис: в колонке цифр дефис читается как прочерк
  const body = (kopecks ? nf2 : nf0).format(Math.abs(n))
  return (n < 0 ? '−' : '') + body + (sign ? ' ₽' : '')
}

/** Коротко, для плиток и графиков: «1,2 млн ₽», «340 тыс. ₽» */
export function moneyShort(v, { sign = true } = {}) {
  const n = num(v)
  if (n == null) return ''
  const a = Math.abs(n)
  const one = (x) => x.toLocaleString('ru-RU', { maximumFractionDigits: x >= 100 ? 0 : 1 })
  let body
  if (a >= 1e9) body = one(a / 1e9) + ' млрд'
  else if (a >= 1e6) body = one(a / 1e6) + ' млн'
  else if (a >= 1e4) body = one(a / 1e3) + ' тыс.'
  else body = nf0.format(a)
  return (n < 0 ? '−' : '') + body + (sign ? ' ₽' : '')
}

/** Доля: «12,5%». Знак плюса — по просьбе, для дельт */
export function percent(v, { digits = 1, plus = false } = {}) {
  const n = num(v)
  if (n == null) return ''
  const body = Math.abs(n).toLocaleString('ru-RU', { maximumFractionDigits: digits })
  return (n < 0 ? '−' : plus && n > 0 ? '+' : '') + body + '%'
}

const toDate = (d) => {
  if (!d) return null
  // Дата без времени — это день, а не полночь по Гринвичу: иначе к западу от
  // него 1 января превращается в 31 декабря
  const dt = d instanceof Date ? d : new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T00:00:00' : d)
  return Number.isNaN(dt.getTime()) ? null : dt
}

/** «15.11.2026» */
export function date(d) {
  return toDate(d)?.toLocaleDateString('ru-RU') ?? ''
}

/** «15.11.2026, 18:00» */
export function dateTime(d) {
  return toDate(d)?.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) ?? ''
}

/** «15 ноя» — там, где год ясен из окружения */
export function dateShort(d) {
  return toDate(d)?.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '') ?? ''
}
