// Справочники плитки «Динамика показателей» — отдельно от компонента,
// чтобы их могла брать страница с настройками

// Цвет показателя закреплён: выручка везде синяя, себестоимость оранжевая —
// глаз запоминает и не перечитывает легенду на каждом графике
export const TREND_INDICATORS = [
  { key: 'revenue',  label: 'Выручка',         color: '#2a78d6' },
  { key: 'cogs',     label: 'Себестоимость',   color: '#eb6834' },
  { key: 'expenses', label: 'Расходы',         color: '#d55181' },
  { key: 'gross',    label: 'Валовая прибыль', color: '#1baf7a' },
  { key: 'profit',   label: 'Прибыль',         color: '#4a3aa7' },
]
export const TREND_META = Object.fromEntries(TREND_INDICATORS.map(i => [i.key, i]))

export const TREND_STEPS = [
  { key: 'auto',  label: 'Авто' },
  { key: 'day',   label: 'По дням' },
  { key: 'month', label: 'По месяцам' },
]
export const TREND_COMPARE = [
  { key: 'none', label: 'Без сравнения' },
  { key: 'prev', label: 'С прошлым периодом' },
  { key: 'year', label: 'С годом назад' },
]
export const TREND_VIEWS = [
  { key: 'auto', label: 'Авто' },
  { key: 'line', label: 'Линии' },
  { key: 'bar',  label: 'Столбцы' },
]
