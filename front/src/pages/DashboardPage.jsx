import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  getDashboardMetrics, getRevenueSeries,
  getDashboardLayout, saveDashboardLayout,
} from '../api/dashboard'
import { getProjects } from '../api/projects'
import Layout from '../components/Layout'
import { SERIES_PALETTE } from '../components/RevenueChart'
import MetricWidget from '../components/widgets/MetricWidget'
import ChartWidget from '../components/widgets/ChartWidget'
import PeriodPicker from '../components/widgets/PeriodPicker'
import {
  INDICATORS, INDICATOR_LABEL,
  WIDTHS, GRID_GAP, widthStyle, defaultLayout, normalizeLayout, newMetric, newChart,
  effectiveProject, resolveWidgetRange, effectiveKind, periodNoun,
  localDateStr, todayStr,
} from '../components/widgets/registry'

const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return localDateStr(d) }
const formatDateShort = (iso) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`
}
const rangeLabel = (from, to) =>
  from === to ? formatDateShort(to) : `${formatDateShort(from)} — ${formatDateShort(to)}`

const sc = 'px-2 py-1 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500'

export default function DashboardPage() {
  const navigate = useNavigate()
  const today = useMemo(() => todayStr(), [])
  // Глобальный период (шапка) — тот же конфиг, что у виджета.
  const [gp, setGp] = useState({ period: 'day', date: yesterday(), offset: 0, from: yesterday(), to: yesterday() })
  const [globalProject, setGlobalProject] = useState('')

  const [projects, setProjects] = useState([])
  const [layout, setLayout] = useState(defaultLayout())
  const [loaded, setLoaded] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [showTiles, setShowTiles] = useState(false)
  const [dragId, setDragId] = useState(null)
  const [metricsByKey, setMetricsByKey] = useState({})
  const [seriesByKey, setSeriesByKey] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getProjects().then(res => setProjects(res.data.data || []))
    getDashboardLayout()
      .then(res => {
        const saved = normalizeLayout(res.data.layout)
        if (saved) setLayout(saved)
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  const colorMap = useMemo(() => {
    const map = {}
    projects.forEach((p, i) => { map[p.id] = SERIES_PALETTE[i] || '#898781' })
    return map
  }, [projects])

  // Запросы по итоговым диапазонам виджетов (метрики и графики — ключ from|to|project)
  const buildReqs = (type) => {
    const map = new Map()
    layout.widgets.forEach(w => {
      if (!w.enabled || w.type !== type) return
      const r = resolveWidgetRange(w, gp, today)
      const proj = effectiveProject(w, globalProject)
      map.set(`${r.from}|${r.to}|${proj}`, { from: r.from, to: r.to, project: proj })
    })
    return map
  }
  const metricReqs = useMemo(() => buildReqs('metric'), [layout, globalProject, gp, today])
  const chartReqs = useMemo(() => buildReqs('chart'), [layout, globalProject, gp, today])

  const metricReqsRef = useRef(new Map()); metricReqsRef.current = metricReqs
  const chartReqsRef = useRef(new Map()); chartReqsRef.current = chartReqs
  const metricSig = [...metricReqs.keys()].sort().join(';')
  const chartSig = [...chartReqs.keys()].sort().join(';')

  const rangeParams = (r) => {
    const p = { date_from: r.from, date_to: r.to }
    if (r.project) p.project_id = r.project
    return p
  }

  useEffect(() => {
    const mReqs = [...metricReqsRef.current.values()]
    const cReqs = [...chartReqsRef.current.values()]
    if (mReqs.length === 0 && cReqs.length === 0) { setMetricsByKey({}); setSeriesByKey({}); setLoading(false); return }
    setLoading(true); setError('')
    Promise.all([
      ...mReqs.map(r => getDashboardMetrics(rangeParams(r)).then(res => ({ t: 'm', key: `${r.from}|${r.to}|${r.project}`, data: res.data }))),
      ...cReqs.map(r => getRevenueSeries(rangeParams(r)).then(res => ({ t: 'c', key: `${r.from}|${r.to}|${r.project}`, data: res.data }))),
    ])
      .then(list => {
        const m = {}, s = {}
        list.forEach(x => { if (x.t === 'm') m[x.key] = x.data; else s[x.key] = x.data })
        setMetricsByKey(m); setSeriesByKey(s)
      })
      .catch(() => setError('Не удалось загрузить данные'))
      .finally(() => setLoading(false))
  }, [metricSig, chartSig])

  // ── Мутации раскладки ──
  const persist = (next) => { setLayout(next); saveDashboardLayout(next).catch(() => {}) }
  const patchWidget = (id, patch) =>
    persist({ ...layout, widgets: layout.widgets.map(w => w.id === id ? { ...w, ...patch } : w) })
  const removeWidget = (id) => {
    persist({ ...layout, widgets: layout.widgets.filter(w => w.id !== id) })
    if (openId === id) setOpenId(null)
  }
  const addWidget = (w) => persist({ ...layout, widgets: [...layout.widgets, w] })
  const resetLayout = () => { persist(defaultLayout()); setShowTiles(false) }

  const onDrop = (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return }
    const ws = [...layout.widgets]
    const from = ws.findIndex(w => w.id === dragId)
    const to = ws.findIndex(w => w.id === targetId)
    if (from < 0 || to < 0) { setDragId(null); return }
    const [m] = ws.splice(from, 1)
    ws.splice(to, 0, m)
    persist({ ...layout, widgets: ws })
    setDragId(null)
  }

  const projName = (id) => projects.find(p => String(p.id) === String(id))?.name || `#${id}`

  // Заголовок плитки: показатель (крупно), период + проект (мельче), даты (совсем мелко)
  const tileMain = (w) => w.type === 'metric' ? (INDICATOR_LABEL[w.indicator] || w.indicator) : 'Выручка по дням'
  const tileSub = (w) => {
    const eff = effectiveProject(w, globalProject)
    const proj = eff ? projName(eff) : ''
    const period = periodNoun(effectiveKind(w, gp))
    return [period, proj].filter(Boolean).join(' · ')
  }
  const tileDates = (w) => {
    const r = resolveWidgetRange(w, gp, today)
    return rangeLabel(r.from, r.to)
  }

  const projectOptions = (
    <>
      <option value="inherit">По умолчанию</option>
      <option value="all">Все проекты</option>
      {projects.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
    </>
  )

  const renderSettings = (w) => (
    <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/70 flex flex-wrap items-center gap-x-4 gap-y-2">
      {w.type === 'metric' ? (
        <>
          <label className="flex items-center gap-1.5 text-xs text-gray-500">Показатель
            <select className={sc} value={w.indicator} onChange={e => patchWidget(w.id, { indicator: e.target.value })}>
              {INDICATORS.map(i => <option key={i.key} value={i.key}>{i.label}</option>)}
            </select>
          </label>
          <span className="flex items-center gap-1.5 text-xs text-gray-500">Период
            <PeriodPicker value={w} onChange={patch => patchWidget(w.id, patch)} allowInherit today={today} />
          </span>
          <label className="flex items-center gap-1 text-xs text-gray-500">
            <input type="checkbox" checked={!!w.breakdown} onChange={e => patchWidget(w.id, { breakdown: e.target.checked })} />
            по проектам
          </label>
        </>
      ) : (
        <span className="flex items-center gap-1.5 text-xs text-gray-500">Период
          <PeriodPicker value={w} onChange={patch => patchWidget(w.id, patch)} allowInherit today={today} />
        </span>
      )}

      <label className="flex items-center gap-1.5 text-xs text-gray-500">Проект
        <select className={sc} value={w.project} onChange={e => patchWidget(w.id, { project: e.target.value })}>
          {projectOptions}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-xs text-gray-500">Ширина
        <select className={sc} value={w.width || 50} onChange={e => patchWidget(w.id, { width: Number(e.target.value) })}>
          {WIDTHS.map(x => <option key={x} value={x}>{x}%</option>)}
        </select>
      </label>

      <div className="ml-auto flex items-center gap-2">
        <button onClick={() => patchWidget(w.id, { enabled: false })} className="text-xs text-gray-500 hover:text-gray-800">Скрыть</button>
        <button onClick={() => removeWidget(w.id)} className="text-xs text-red-500 hover:text-red-700">Удалить</button>
      </div>
    </div>
  )

  const renderBody = (w) => {
    const proj = effectiveProject(w, globalProject)
    const r = resolveWidgetRange(w, gp, today)
    const key = `${r.from}|${r.to}|${proj}`
    if (w.type === 'metric') {
      return <MetricWidget widget={w} data={metricsByKey[key]} allProjects={proj === ''} colorMap={colorMap} />
    }
    return <ChartWidget series={seriesByKey[key]} colorMap={colorMap} />
  }

  const visible = layout.widgets.filter(w => w.enabled)
  const hidden = layout.widgets.filter(w => !w.enabled)

  return (
    <Layout>
      <div className="space-y-5">
        {/* Тулбар */}
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Дашборд</h1>
            <p className="text-sm text-gray-500 mt-1">Плитки настраиваются каждая отдельно · перетаскивайте за заголовок</p>
          </div>
          <div className="flex items-end gap-3 flex-wrap">
            {projects.length > 1 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-gray-500 font-medium">Проект (по умолчанию)</span>
                <select value={globalProject} onChange={e => setGlobalProject(e.target.value)}
                  className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-40">
                  <option value="">Все проекты</option>
                  {projects.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 font-medium">Период (по умолчанию)</span>
              <PeriodPicker value={gp} onChange={patch => setGp({ ...gp, ...patch })} today={today} />
            </div>
            <button onClick={() => setShowTiles(true)} disabled={!loaded}
              className="px-4 py-1.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              Плитки
            </button>
          </div>
        </div>

        {error && <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}

        {!loaded ? (
          <div className="text-sm text-gray-400 py-8 text-center">Загрузка…</div>
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-10 text-center text-sm text-gray-400">
            Нет активных плиток. Нажмите «Плитки», чтобы добавить или показать скрытые.
          </div>
        ) : (
          <div className={`flex flex-wrap items-start ${loading ? 'opacity-60' : ''}`} style={{ gap: `${GRID_GAP}px` }}>
            {visible.map((w) => (
              <section
                key={w.id}
                style={widthStyle(w.width)}
                onDragOver={(e) => { if (dragId) e.preventDefault() }}
                onDrop={() => onDrop(w.id)}
                className={`bg-white rounded-xl border shadow-sm ${dragId === w.id ? 'opacity-40' : ''} ${dragId && dragId !== w.id ? 'border-dashed border-blue-300' : 'border-gray-100'}`}
              >
                <div
                  draggable
                  onDragStart={(e) => { setDragId(w.id); e.dataTransfer.setData('text/plain', w.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => setDragId(null)}
                  className="flex items-start justify-between gap-2 px-5 py-3 border-b border-gray-100 cursor-move"
                >
                  <div className="min-w-0 flex items-start gap-2">
                    <span className="text-gray-300 select-none mt-0.5" title="Перетащить">≡</span>
                    <div className="min-w-0">
                      <h2 className="font-semibold text-gray-800 truncate leading-tight">{tileMain(w)}</h2>
                      {tileSub(w) && <div className="text-xs text-gray-500 truncate">{tileSub(w)}</div>}
                      {tileDates(w) && <div className="text-[11px] text-gray-400 truncate">{tileDates(w)}</div>}
                    </div>
                  </div>
                  <button
                    onClick={() => setOpenId(openId === w.id ? null : w.id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={`flex-shrink-0 p-1.5 rounded-lg ${openId === w.id ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'}`}
                    title="Настройки плитки"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                </div>

                {openId === w.id && renderSettings(w)}
                {renderBody(w)}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* Модал «Плитки» */}
      {showTiles && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowTiles(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">Плитки</h3>
              <button onClick={() => setShowTiles(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <div className="p-6 space-y-6">
              <div>
                <p className="text-xs text-gray-500 font-medium mb-2">Добавить плитку</p>
                <div className="flex gap-2">
                  <button onClick={() => addWidget(newMetric())} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">+ Показатель</button>
                  <button onClick={() => addWidget(newChart())} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">+ График</button>
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500 font-medium mb-2">Скрытые плитки</p>
                {hidden.length === 0 ? (
                  <p className="text-sm text-gray-400">Нет скрытых плиток</p>
                ) : (
                  <div className="space-y-2">
                    {hidden.map(w => (
                      <div key={w.id} className="flex items-center justify-between gap-3 border border-gray-100 rounded-lg px-3 py-2">
                        <span className="text-sm text-gray-700 truncate">{tileMain(w)}{tileSub(w) ? ` · ${tileSub(w)}` : ''}</span>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <button onClick={() => patchWidget(w.id, { enabled: true })} className="text-sm text-blue-600 hover:text-blue-700">Показать</button>
                          <button onClick={() => removeWidget(w.id)} className="text-sm text-gray-400 hover:text-red-600">✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="pt-2 border-t border-gray-100 flex justify-end">
                <button onClick={resetLayout} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
                  ↺ Сбросить к стандартной раскладке
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
