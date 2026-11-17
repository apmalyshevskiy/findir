// Справочники и конструкторы для системы виджетов дашборда.

export const PERIODS = [
  { key: 'day',   title: 'За день' },
  { key: 'week',  title: 'За 7 дней' },
  { key: 'month', title: 'За месяц' },
  { key: 'year',  title: 'За год' },
  { key: 'last12', title: 'За 12 месяцев' },
]
export const INHERIT_PERIOD = { key: 'inherit', title: 'Как в шапке' }
export const CUSTOM_PERIOD  = { key: 'custom',  title: 'Произвольный' }

// Пресеты для шапки (глобальный период) и для виджета (+ «как в шапке»).
export const HEADER_PERIOD_OPTIONS = [...PERIODS, CUSTOM_PERIOD]
export const WIDGET_PERIOD_OPTIONS = [INHERIT_PERIOD, ...PERIODS, CUSTOM_PERIOD]

export const PERIOD_TITLE = Object.fromEntries(
  [...PERIODS, INHERIT_PERIOD, CUSTOM_PERIOD].map(p => [p.key, p.title])
)

export const localDateStr = (d) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return x.toISOString().slice(0, 10)
}

export const todayStr = () => localDateStr(new Date())

// ── Календарные диапазоны (относительно сегодняшнего дня) ──
// offset: 0 = текущий, -1 = предыдущий, -2 = позапрошлый …

const startOfWeekMon = (date) => {
  const x = new Date(date)
  const dow = (x.getDay() + 6) % 7  // 0 = понедельник
  x.setDate(x.getDate() - dow); x.setHours(0, 0, 0, 0)
  return x
}
export const weekRange = (offset, today) => {
  const s = startOfWeekMon(new Date(today + 'T00:00:00'))
  s.setDate(s.getDate() + offset * 7)
  const e = new Date(s); e.setDate(e.getDate() + 6)
  return { from: localDateStr(s), to: localDateStr(e) }
}
export const monthRange = (offset, today) => {
  const d = new Date(today + 'T00:00:00')
  const first = new Date(d.getFullYear(), d.getMonth() + offset, 1)
  const last  = new Date(d.getFullYear(), d.getMonth() + offset + 1, 0)
  return { from: localDateStr(first), to: localDateStr(last) }
}
export const yearRange = (offset, today) => {
  const y = new Date(today + 'T00:00:00').getFullYear() + offset
  return { from: `${y}-01-01`, to: `${y}-12-31` }
}

// Диапазон {from, to} по конфигу периода.
export const resolveRange = (p, today) => {
  switch (p.period) {
    case 'day':    return { from: p.date || today, to: p.date || today }
    case 'week':   return weekRange(p.offset || 0, today)
    case 'month':  return monthRange(p.offset || 0, today)
    case 'year':   return yearRange(p.offset || 0, today)
    // Скользящие 12 месяцев, включая текущий: год помесячно без привязки к январю
    case 'last12': return { from: monthRange(-11, today).from, to: monthRange(0, today).to }
    case 'custom': return { from: p.from || today, to: p.to || today }
    default:       return { from: today, to: today }
  }
}
// Итоговый диапазон виджета: наследует глобальный или свой.
export const resolveWidgetRange = (w, global, today) =>
  w.period === 'inherit' ? resolveRange(global, today) : resolveRange(w, today)

// Эффективный вид периода (для «как в шапке» разворачиваем в глобальный).
export const effectiveKind = (w, global) => (w.period === 'inherit' ? global.period : w.period)

// Подпись периода в плитке: «за день/неделю/месяц/год»; для произвольного — пусто.
const PERIOD_NOUN = { day: 'за день', week: 'за неделю', month: 'за месяц', year: 'за год', last12: 'за 12 месяцев' }
export const periodNoun = (kind) => PERIOD_NOUN[kind] || ''

// ── Подписи для выпадашек смещения ──
export const WEEK_OFFSETS = [0, -1, -2, -3]
export const MONTH_OFFSETS = [0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11]
export const YEAR_OFFSETS = [0, -1, -2, -3, -4]

export const weekOffsetLabel = (o) =>
  o === 0 ? 'Текущая неделя' : o === -1 ? 'Предыдущая неделя' : `${-o} нед. назад`
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)
export const monthOffsetLabel = (o, today) => {
  const d = new Date(today + 'T00:00:00')
  const m = new Date(d.getFullYear(), d.getMonth() + o, 1)
  return capitalize(m.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })) + (o === 0 ? ' (текущий)' : '')
}
export const yearOffsetLabel = (o, today) =>
  String(new Date(today + 'T00:00:00').getFullYear() + o) + (o === 0 ? ' (текущий)' : '')

// Показатели. Добавить новый = одна строка (плюс поле в total/by_project на бэкенде).
export const INDICATORS = [
  { key: 'revenue',  label: 'Выручка' },
  { key: 'cogs',     label: 'Себестоимость' },
  { key: 'gross',    label: 'Валовая прибыль' },
  { key: 'expenses', label: 'Расходы' },
  { key: 'profit',   label: 'Прибыль' },
  { key: 'foodcost', label: 'Доля себестоимости' },
]
export const INDICATOR_LABEL = Object.fromEntries(INDICATORS.map(i => [i.key, i.label]))

// Доступные окна для графика по дням.
export const CHART_SPANS = [7, 14, 30, 90]

// Доступные ширины виджета в процентах.
export const WIDTHS = [20, 25, 33, 50, 67, 75, 100]

// Зазор между виджетами (px) — должен совпадать со стилем контейнера.
export const GRID_GAP = 20

// Ширина flex-элемента с учётом доли зазора, чтобы проценты вставали ровно:
//   виджеты одного ряда с суммой процентов ≤ 100 умещаются без переноса.
export const widthStyle = (percent) => {
  const p = percent || 100
  return {
    width: `calc(${p}% - ${(GRID_GAP * (100 - p) / 100).toFixed(2)}px)`,
    minWidth: 180,
  }
}

let seq = 0
export const uid = () => `w${Date.now().toString(36)}${(seq++).toString(36)}`

// period: 'inherit' | 'day' | 'week' | 'month' | 'year' | 'custom'
//   day → date; week/month/year → offset (0=текущий, -1=предыдущий); custom → from/to
// project: 'inherit' (глобальный фильтр) | 'all' (все проекты) | <id проекта>
export const newMetric = () => ({
  id: uid(), type: 'metric', indicator: 'revenue',
  period: 'week', offset: 0, date: '', from: '', to: '',
  project: 'inherit', breakdown: false, enabled: true, width: 50,
})

export const newChart = () => ({
  id: uid(), type: 'chart',
  period: 'month', offset: 0, date: '', from: '', to: '',
  project: 'inherit', enabled: true, width: 100,
})

// Динамика показателей: несколько рядов, шаг дни/месяцы, сравнение
export const newTrend = () => ({
  id: uid(), type: 'trend',
  period: 'inherit', offset: 0, date: '', from: '', to: '',
  indicators: ['revenue', 'cogs', 'expenses'], step: 'auto', compare: 'prev', view: 'auto',
  project: 'inherit', enabled: true, width: 100,
})

/**
 * Плитки без настраиваемого периода: у них свой, заданный смыслом.
 * Остаток денег берётся на сегодня, план — на текущий месяц, платежи — на две
 * недели вперёд; «выручка за прошлый год» к ним неприменима.
 */
export const FIXED_TILES = {
  cash:     { title: 'Деньги',            sub: 'остаток на сегодня',     to: '/balance-sheet',    linkLabel: 'Оборотка' },
  budget:   { title: 'План и факт',       sub: 'текущий месяц',          to: '/budget',           linkLabel: 'Бюджет' },
  payments: { title: 'Ближайшие платежи', sub: 'на две недели вперёд',   to: '/payment-calendar', linkLabel: 'Календарь' },
}

export const newCash     = () => ({ id: uid(), type: 'cash',     project: 'inherit', enabled: true, width: 33 })
export const newBudget   = () => ({ id: uid(), type: 'budget',   enabled: true, width: 50 })
export const newPayments = () => ({ id: uid(), type: 'payments', enabled: true, width: 50 })

// Приводим сохранённую раскладку к текущей модели (старые графики со span → период).
export const normalizeLayout = (l) => {
  if (!l || !Array.isArray(l.widgets)) return null
  // Период дописываем только плиткам, у которых он есть: у «денег» и «плана»
  // его нет по смыслу
  return { ...l, widgets: l.widgets.map(w => (w.period || FIXED_TILES[w.type]) ? w : { ...w, period: (w.type === 'chart' || w.type === 'trend') ? 'month' : 'day' }) }
}

/**
 * Раскладка для того, кто открыл дашборд впервые.
 *
 * Сверху — три ответа на три первых вопроса: сколько денег, сколько
 * заработали, сколько осталось. Ниже — идём ли по плану и что платить. График
 * — последним: он про динамику, а к ней переходят, когда ясно текущее.
 */
export const defaultLayout = () => ({
  widgets: [
    newCash(),
    { id: uid(), type: 'metric', indicator: 'revenue', period: 'inherit', offset: 0, project: 'inherit', breakdown: false, enabled: true, width: 33 },
    { id: uid(), type: 'metric', indicator: 'profit',  period: 'inherit', offset: 0, project: 'inherit', breakdown: false, enabled: true, width: 33 },
    newBudget(),
    newPayments(),
    newTrend(),
  ],
})

// Эффективный фильтр проекта виджета: '' = все проекты, иначе id (строкой).
export const effectiveProject = (widget, globalProject) => {
  if (widget.project === 'all') return ''
  if (widget.project === 'inherit' || widget.project == null) return globalProject || ''
  return String(widget.project)
}
