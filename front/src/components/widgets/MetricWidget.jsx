const formatMoney = (v) =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0)

const formatPercent = (v) =>
  `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v || 0)} %`

const FORMATTERS = {
  revenue:  formatMoney,
  cogs:     formatMoney,
  foodcost: formatPercent,
}
const fmt = (indicator, v) => (FORMATTERS[indicator] || String)(v)

// props:
//   widget   — конфиг {indicator, breakdown, ...}
//   data     — {total, by_project} за итоговый диапазон виджета
//   allProjects — true, если фильтр = «все проекты» (тогда возможна разбивка)
//   colorMap — цвет по id проекта (для маркеров разбивки)
export default function MetricWidget({ widget, data, allProjects, colorMap = {} }) {
  if (!data) {
    return <div className="p-5 text-sm text-gray-400">Загрузка…</div>
  }

  const key = widget.indicator
  const byProject = data.by_project || []
  const showBreakdown = widget.breakdown && allProjects && byProject.length > 1

  return (
    <div className="p-5">
      {/* Крупная цифра — итог */}
      <p className="text-3xl font-bold text-blue-600">{fmt(key, data.total?.[key])}</p>

      {/* Разбивка по проектам — строки под итогом */}
      {showBreakdown && (
        <div className="mt-3 border-t border-gray-100 pt-2 space-y-1">
          {byProject.map(row => (
            <div key={row.project_id} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5 text-gray-600 min-w-0">
                <span className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: colorMap[row.project_id] || '#898781' }} />
                <span className="truncate">{row.name}</span>
              </span>
              <span className="font-medium text-gray-800 tabular-nums flex-shrink-0">{fmt(key, row[key])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
