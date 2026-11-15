import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  getDashboardMetrics, getRevenueSeries,
  getDashboardLayout, saveDashboardLayout,
} from '../api/dashboard'
import { getProjects } from '../api/projects'
import Layout from '../components/Layout'
import FirstSteps from '../components/FirstSteps'
import { SERIES_PALETTE } from '../components/RevenueChart'
import MetricWidget from '../components/widgets/MetricWidget'
import { CashWidget, BudgetProgressWidget, UpcomingPaymentsWidget } from '../components/widgets/FinanceWidgets'
import { ArrowUpRight, GripVertical, LayoutGrid, Plus, RotateCcw, Settings, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, IconButton, Modal, PageHeader, toast } from '../components/ui'
import { SkeletonRows } from '../components/Busy'
import usePersistedState from '../hooks/usePersistedState'
import ChartWidget from '../components/widgets/ChartWidget'
import PeriodPicker from '../components/widgets/PeriodPicker'
import {
  INDICATORS, INDICATOR_LABEL,
  WIDTHS, GRID_GAP, widthStyle, defaultLayout, normalizeLayout, newMetric, newChart,
  FIXED_TILES, newCash, newBudget, newPayments,
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

const sc = 'h-7 px-2 border border-gray-200 rounded-lg text-xs bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500'

export default function DashboardPage() {
  const navigate = useNavigate()
  const today = useMemo(() => todayStr(), [])
  // Глобальный период (шапка) — тот же конфиг, что у виджета.
  // По умолчанию — текущий месяц. Раньше стоял «вчерашний день»: одна точка,
  // на которой график пуст, а цифра не говорит ничего без соседних
  const [gp, setGp] = useState({ period: 'month', date: yesterday(), offset: 0, from: yesterday(), to: yesterday() })
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
  // Есть ли у человека своя сохранённая раскладка и видел ли он предложение
  // добавить новые плитки: молча менять то, что он собрал сам, нельзя
  const [hasSaved, setHasSaved] = useState(false)
  const [offerSeen, setOfferSeen] = usePersistedState('dash:financeTilesOffer', false)

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getProjects().then(res => setProjects(res.data.data || []))
    getDashboardLayout()
      .then(res => {
        const saved = normalizeLayout(res.data.layout)
        if (saved) { setLayout(saved); setHasSaved(true) }
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
  // Раскладка не сохранилась — говорим: иначе после перезагрузки плитки
  // вернулись бы на старые места без объяснения
  const persist = (next) => {
    setLayout(next)
    saveDashboardLayout(next).catch(() => toast.error('Раскладка не сохранилась — после перезагрузки она вернётся к прежней'))
  }
  const patchWidget = (id, patch) =>
    persist({ ...layout, widgets: layout.widgets.map(w => w.id === id ? { ...w, ...patch } : w) })
  const removeWidget = (id) => {
    persist({ ...layout, widgets: layout.widgets.filter(w => w.id !== id) })
    if (openId === id) setOpenId(null)
  }
  const addWidget = (w) => persist({ ...layout, widgets: [...layout.widgets, w] })
  // Удаление плитки — в один клик, но с возвратом: настроенную плитку жалко
  // терять из-за промаха, а спрашивать «вы уверены?» на каждую — навязчиво
  const removeWidgetUndo = (w) => {
    const before = layout
    removeWidget(w.id)
    toast(`Плитка «${tileMain(w)}» удалена`, { action: { label: 'Вернуть', onClick: () => persist(before) } })
  }
  // Новые плитки — тем, у кого раскладка собрана раньше, чем они появились
  const addFinanceTiles = () => {
    const have = new Set(layout.widgets.map(w => w.type))
    const fresh = [newCash(), newBudget(), newPayments()].filter(w => !have.has(w.type))
    persist({ ...layout, widgets: [...fresh, ...layout.widgets] })
    setOfferSeen(true)
  }
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
  const tileMain = (w) => FIXED_TILES[w.type]?.title
    || (w.type === 'metric' ? (INDICATOR_LABEL[w.indicator] || w.indicator) : 'Выручка по дням')
  const tileSub = (w) => {
    if (FIXED_TILES[w.type]) {
      const eff = w.type === 'cash' ? effectiveProject(w, globalProject) : ''
      return [FIXED_TILES[w.type].sub, eff ? projName(eff) : ''].filter(Boolean).join(' · ')
    }
    const eff = effectiveProject(w, globalProject)
    const proj = eff ? projName(eff) : ''
    const period = periodNoun(effectiveKind(w, gp))
    return [period, proj].filter(Boolean).join(' · ')
  }
  const tileDates = (w) => {
    if (FIXED_TILES[w.type]) return ''
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
      ) : !FIXED_TILES[w.type] && (
        <span className="flex items-center gap-1.5 text-xs text-gray-500">Период
          <PeriodPicker value={w} onChange={patch => patchWidget(w.id, patch)} allowInherit today={today} />
        </span>
      )}

      {/* Проект есть там, где по нему можно отобрать: план и календарь
          ведутся на компанию целиком */}
      {(!FIXED_TILES[w.type] || w.type === 'cash') && (
        <label className="flex items-center gap-1.5 text-xs text-gray-500">Проект
          <select className={sc} value={w.project} onChange={e => patchWidget(w.id, { project: e.target.value })}>
            {projectOptions}
          </select>
        </label>
      )}

      <label className="flex items-center gap-1.5 text-xs text-gray-500">Ширина
        <select className={sc} value={w.width || 50} onChange={e => patchWidget(w.id, { width: Number(e.target.value) })}>
          {WIDTHS.map(x => <option key={x} value={x}>{x}%</option>)}
        </select>
      </label>

      <div className="ml-auto flex items-center gap-2">
        <Button size="xs" variant="ghost" onClick={() => patchWidget(w.id, { enabled: false })}>Скрыть</Button>
        <Button size="xs" variant="danger-ghost" onClick={() => removeWidgetUndo(w)}>Удалить</Button>
      </div>
    </div>
  )

  const renderBody = (w) => {
    const proj = effectiveProject(w, globalProject)
    const r = resolveWidgetRange(w, gp, today)
    const key = `${r.from}|${r.to}|${proj}`
    if (w.type === 'cash')     return <CashWidget today={today} project={proj} />
    if (w.type === 'budget')   return <BudgetProgressWidget today={today} />
    if (w.type === 'payments') return <UpcomingPaymentsWidget today={today} />
    if (w.type === 'metric') {
      return <MetricWidget widget={w} data={metricsByKey[key]} allProjects={proj === ''} colorMap={colorMap} />
    }
    return <ChartWidget series={seriesByKey[key]} colorMap={colorMap} />
  }

  const visible = layout.widgets.filter(w => w.enabled)
  const hidden = layout.widgets.filter(w => !w.enabled)
  // Предлагаем один раз и только тому, у кого ни одной из новых плиток нет
  const offerFinance = loaded && hasSaved && !offerSeen && !layout.widgets.some(w => FIXED_TILES[w.type])

  return (
    <Layout>
      {/* Первые шаги — выше виджетов и до тех пор, пока не пройдены все */}
      <FirstSteps />

      <div>
        <PageHeader title="Дашборд"
          subtitle="Деньги, план и показатели на одном экране. Плитки настраиваются и перетаскиваются"
          actions={<>
            {projects.length > 1 && (
              <select value={globalProject} onChange={e => setGlobalProject(e.target.value)} title="Проект для всех плиток"
                className="h-9 px-3 border border-gray-200 rounded-lg text-sm bg-white shadow-sm hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500 min-w-40">
                <option value="">Все проекты</option>
                {projects.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
              </select>
            )}
            <PeriodPicker value={gp} onChange={patch => setGp({ ...gp, ...patch })} today={today} />
            <Button icon={LayoutGrid} onClick={() => setShowTiles(true)} disabled={!loaded}>Плитки</Button>
          </>} />

        {offerFinance && (
          <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 rounded-xl bg-gold-50 border border-gold-200">
            <p className="flex-1 min-w-[16rem] text-sm text-gold-900">
              <span className="font-medium">Появились новые плитки:</span> остаток денег по кассам, план и факт месяца, ближайшие платежи.
            </p>
            <Button size="sm" variant="gold" icon={Plus} onClick={addFinanceTiles}>Добавить на дашборд</Button>
            <IconButton icon={X} size="sm" label="Не предлагать" onClick={() => setOfferSeen(true)} />
          </div>
        )}

        {error && <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}

        {!loaded ? (
          <SkeletonRows rows={3} height="h-28" />
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200/80 shadow-card px-5 py-10 text-center text-sm text-gray-500">
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
                className={`group/tile bg-white rounded-xl border shadow-card ${dragId === w.id ? 'opacity-40' : ''} ${dragId && dragId !== w.id ? 'border-dashed border-brand-300' : 'border-gray-200/80'}`}
              >
                <div
                  draggable
                  onDragStart={(e) => { setDragId(w.id); e.dataTransfer.setData('text/plain', w.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => setDragId(null)}
                  className="flex items-start justify-between gap-2 pl-3 pr-3 pt-3.5 pb-3 border-b border-gray-100 cursor-move"
                >
                  <div className="min-w-0 flex items-start gap-1.5">
                    <GripVertical className="w-4 h-4 mt-0.5 text-gray-300 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold text-gray-800 truncate leading-5">{tileMain(w)}</h2>
                      <div className="text-xs text-gray-500 truncate">
                        {[tileSub(w), tileDates(w)].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                    {/* Из плитки — в отчёт, где это число раскрыто по строкам */}
                    {FIXED_TILES[w.type] && (
                      <Link to={FIXED_TILES[w.type].to} draggable={false}
                        className="inline-flex items-center gap-0.5 h-7 px-2 rounded-md text-xs font-medium text-brand-700 hover:bg-brand-50">
                        {FIXED_TILES[w.type].linkLabel}
                        <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
                      </Link>
                    )}
                    <IconButton icon={Settings} size="sm" label="Настройки плитки"
                      className={openId === w.id ? 'bg-brand-50 text-brand-700' : ''}
                      onClick={() => setOpenId(openId === w.id ? null : w.id)} />
                  </div>
                </div>

                {openId === w.id && renderSettings(w)}
                {renderBody(w)}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* Окно «Плитки» */}
      <Modal open={showTiles} onClose={() => setShowTiles(false)} title="Плитки"
        subtitle="Что показывать на дашборде. Порядок меняется перетаскиванием прямо на странице">
        <div className="space-y-6">
          <div>
            <p className="text-xs font-medium text-gray-500 mb-2">Добавить плитку</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={Plus} onClick={() => addWidget(newMetric())}>Показатель</Button>
              <Button size="sm" icon={Plus} onClick={() => addWidget(newChart())}>График выручки</Button>
              <Button size="sm" icon={Plus} onClick={() => addWidget(newCash())}>Деньги</Button>
              <Button size="sm" icon={Plus} onClick={() => addWidget(newBudget())}>План и факт</Button>
              <Button size="sm" icon={Plus} onClick={() => addWidget(newPayments())}>Платежи</Button>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 mb-2">Скрытые плитки</p>
            {hidden.length === 0 ? (
              <p className="text-sm text-gray-500">Скрытых плиток нет</p>
            ) : (
              <div className="space-y-2">
                {hidden.map(w => (
                  <div key={w.id} className="flex items-center justify-between gap-3 border border-gray-200 rounded-lg pl-3 pr-1.5 py-1.5">
                    <span className="text-sm text-gray-700 truncate">{tileMain(w)}{tileSub(w) ? ` · ${tileSub(w)}` : ''}</span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button size="xs" variant="ghost" onClick={() => patchWidget(w.id, { enabled: true })}>Показать</Button>
                      <IconButton icon={X} size="sm" variant="danger" label="Удалить плитку" onClick={() => removeWidgetUndo(w)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="pt-4 border-t border-gray-100">
            <Button variant="ghost" size="sm" icon={RotateCcw} onClick={resetLayout}>Вернуть стандартную раскладку</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
