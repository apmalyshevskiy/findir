import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { getDashboardSummary } from '../api/dashboard'
import { getProjects } from '../api/projects'
import Layout from '../components/Layout'

// Локальная дата YYYY-MM-DD без сдвига в UTC.
const localDate = (d) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return x.toISOString().slice(0, 10)
}

const yesterday = () => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return localDate(d)
}

const formatMoney = (amount) =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(amount || 0)

const formatDateShort = (iso) => {
  if (!iso) return ''
  const [y, m, day] = iso.split('-')
  return `${day}.${m}.${y}`
}

// Периоды-блоки, сверху вниз по странице.
const PERIODS = [
  { key: 'day',   title: 'За день' },
  { key: 'week',  title: 'За 7 дней' },
  { key: 'month', title: 'За месяц' },
  { key: 'year',  title: 'За год' },
]

// Показатели внутри каждого блока. Добавить новый показатель = одна строка.
//   key         — поле в ответе бэкенда (total.<key> и by_project[].<key>)
//   hidePeriods — периоды, для которых показатель не имеет смысла (например, ['day'])
const INDICATORS = [
  { key: 'revenue', label: 'Выручка', accent: 'text-blue-600', format: formatMoney, hidePeriods: [] },
]

const fmt = (ind, v) => (ind.format ? ind.format(v) : (v ?? '—'))

export default function DashboardPage() {
  const navigate = useNavigate()
  const [date, setDate] = useState(yesterday())
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getProjects().then(res => setProjects(res.data.data || []))
  }, [])

  useEffect(() => {
    setLoading(true)
    setError('')
    const params = { date }
    if (projectId) params.project_id = projectId
    getDashboardSummary(params)
      .then(res => setSummary(res.data))
      .catch(() => setError('Не удалось загрузить показатели'))
      .finally(() => setLoading(false))
  }, [date, projectId])

  const periods = summary?.periods || {}
  // Разбивку по проектам показываем, только если проектов несколько и не выбран конкретный.
  const showBreakdown = projects.length > 1 && !projectId

  const rangeLabel = (key, p) => {
    if (!p) return ''
    return key === 'day'
      ? formatDateShort(p.date_to)
      : `${formatDateShort(p.date_from)} — ${formatDateShort(p.date_to)}`
  }

  // Таблица «проект → показатели» + строка «Итого».
  const renderBreakdown = (p, indicators) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-100">
            <th className="text-left px-5 py-2 font-medium">Проект</th>
            {indicators.map(ind => (
              <th key={ind.key} className="text-right px-5 py-2 font-medium">{ind.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(p?.by_project || []).length === 0 ? (
            <tr>
              <td colSpan={indicators.length + 1} className="px-5 py-3 text-gray-400">Нет данных за период</td>
            </tr>
          ) : (
            p.by_project.map(row => (
              <tr key={row.project_id} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-5 py-2 text-gray-700">{row.name}</td>
                {indicators.map(ind => (
                  <td key={ind.key} className={`px-5 py-2 text-right font-medium ${ind.accent}`}>
                    {fmt(ind, row[ind.key])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-200 bg-gray-50">
            <td className="px-5 py-2 text-xs font-semibold text-gray-600">Итого</td>
            {indicators.map(ind => (
              <td key={ind.key} className={`px-5 py-2 text-right font-bold ${ind.accent}`}>
                {fmt(ind, p?.total?.[ind.key])}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )

  // Карточки итога — когда проект один или выбран конкретный.
  const renderTotals = (p, indicators) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-gray-100">
      {indicators.map(ind => (
        <div key={ind.key} className="bg-white p-5">
          <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">{ind.label}</p>
          <p className={`text-2xl font-bold ${ind.accent}`}>{fmt(ind, p?.total?.[ind.key])}</p>
        </div>
      ))}
    </div>
  )

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Дашборд</h1>
            <p className="text-sm text-gray-500 mt-1">Показатели по периодам от выбранной даты</p>
          </div>
          <div className="flex items-end gap-4 flex-wrap">
            {projects.length > 1 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-gray-500 font-medium">Проект</span>
                <select
                  value={projectId}
                  onChange={e => setProjectId(e.target.value)}
                  className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48"
                >
                  <option value="">Все проекты</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 font-medium">Дата (конец периодов)</span>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {error && <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}

        {/* Блоки-секции по периодам, сверху вниз */}
        <div className={`space-y-5 ${loading ? 'opacity-50' : ''}`}>
          {PERIODS.map(({ key, title }) => {
            const p = periods[key]
            const indicators = INDICATORS.filter(ind => !ind.hidePeriods?.includes(key))
            return (
              <section key={key} className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="flex items-baseline justify-between px-5 py-3 border-b border-gray-100">
                  <h2 className="font-semibold text-gray-800">{title}</h2>
                  <span className="text-xs text-gray-400">{rangeLabel(key, p)}</span>
                </div>
                {indicators.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-gray-400">Нет показателей для этого периода</div>
                ) : showBreakdown ? (
                  renderBreakdown(p, indicators)
                ) : (
                  renderTotals(p, indicators)
                )}
              </section>
            )
          })}
        </div>
      </div>
    </Layout>
  )
}
