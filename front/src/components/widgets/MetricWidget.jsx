import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { money, percent, date as fmtDate } from '../../utils/format'

const formatMoney = (v) => money(v, { kopecks: false })
const formatPercent = (v) => percent(v).replace('%', ' %')

const FORMATTERS = {
  revenue:  formatMoney,
  cogs:     formatMoney,
  expenses: formatMoney,
  gross:    formatMoney,
  profit:   formatMoney,
  foodcost: formatPercent,
}

/**
 * У каких показателей рост — плохая новость. Выручка выросла — хорошо,
 * расходы выросли — нет; красить оба роста зелёным значило бы врать цветом.
 */
const LESS_IS_BETTER = new Set(['cogs', 'expenses', 'foodcost'])

/**
 * null — не ноль.
 *
 * Счёт показателя может быть закрыт должностью; сервер тогда присылает null.
 * Показать вместо этого «0 ₽» значило бы соврать: человек пошёл бы искать,
 * куда делась выручка.
 */
const fmt = (indicator, v) =>
  v === null || v === undefined ? '—' : (FORMATTERS[indicator] || String)(v)

/**
 * Сравнение с прошлым периодом.
 *
 * Число на плитке само по себе не говорит ничего: «28 млн» — это много или
 * мало? Отвечает на это только «было». Для долей (фудкост) показываем разницу
 * в процентных пунктах: «процент от процента» читается неправильно.
 */
function Delta({ indicator, now, was, prevRange }) {
  if (now == null || was == null) return null

  const isShare = indicator === 'foodcost'
  const diff = now - was
  // Было ноль — относительного изменения нет, делить не на что
  if (!isShare && Math.abs(was) < 0.005) return null

  const value = isShare ? diff : (diff / Math.abs(was)) * 100
  const flat = Math.abs(value) < 0.05
  const good = flat ? null : (diff > 0) !== LESS_IS_BETTER.has(indicator)
  const Icon = flat ? Minus : diff > 0 ? ArrowUpRight : ArrowDownRight

  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs"
      title={prevRange ? `Сравнение с ${fmtDate(prevRange.date_from)} — ${fmtDate(prevRange.date_to)}: было ${fmt(indicator, was)}` : undefined}>
      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md font-medium tabular-nums ${
        good === null ? 'bg-gray-100 text-gray-600' : good ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        {flat ? 'без изменений' : isShare
          ? `${percent(value, { plus: true }).replace('%', '')} п.п.`
          : percent(value, { plus: true })}
      </span>
      <span className="text-gray-500">к прошлому периоду</span>
    </div>
  )
}

// props:
//   widget   — конфиг {indicator, breakdown, ...}
//   data     — {total, by_project, previous} за итоговый диапазон виджета
//   allProjects — true, если фильтр = «все проекты» (тогда возможна разбивка)
//   colorMap — цвет по id проекта (для маркеров разбивки)
export default function MetricWidget({ widget, data, allProjects, colorMap = {} }) {
  if (!data) {
    return (
      <div className="p-5" aria-hidden="true">
        <div className="h-8 w-40 rounded-lg bg-gray-100 animate-pulse" />
        <div className="mt-3 h-4 w-28 rounded bg-gray-100 animate-pulse" />
      </div>
    )
  }

  const key = widget.indicator
  const byProject = data.by_project || []
  const showBreakdown = widget.breakdown && allProjects && byProject.length > 1
  const value = data.total?.[key]

  return (
    <div className="p-5">
      {/* Крупная цифра — итог. Убыток — красным: минус перед числом легко
          проглядеть, а это главное, что нужно увидеть */}
      <p className={`text-[1.75rem] leading-9 font-semibold tracking-tight tabular-nums ${
        (key === 'profit' || key === 'gross') && value < 0 ? 'text-red-600' : 'text-gray-900'}`}>
        {fmt(key, value)}
      </p>

      <Delta indicator={key} now={value} was={data.previous?.total?.[key]} prevRange={data.previous} />

      {/* Разбивка по проектам — строки под итогом */}
      {showBreakdown && (
        <div className="mt-4 border-t border-gray-100 pt-3 space-y-1.5">
          {byProject.map(row => (
            <div key={row.project_id} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-gray-600 min-w-0">
                <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: colorMap[row.project_id] || '#898781' }} />
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
