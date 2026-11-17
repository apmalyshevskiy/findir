import { useEffect, useMemo, useRef, useState } from 'react'
import { getIndicatorSeries } from '../../api/dashboard'
import { moneyShort, money, percent } from '../../utils/format'
import { TREND_META as META } from './trendMeta'

/**
 * Динамика показателей: несколько показателей на одном графике, по дням или
 * по месяцам, и второй ряд для сравнения — прошлый период или год назад.
 *
 * Раньше на дашборде был только график выручки по дням за один период:
 * посмотреть год помесячно, положить рядом выручку и себестоимость или
 * сравнить ноябрь с октябрём было нельзя.
 */

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

const pointLabel = (p, step, withYear) => {
  if (!p) return ''
  if (step === 'month') {
    const [y, m] = p.split('-')
    return MONTHS[Number(m) - 1] + (withYear ? ` ${y.slice(2)}` : '')
  }
  const [, m, d] = p.split('-')
  return `${d}.${m}`
}
const pointTitle = (p, step) => {
  if (!p) return ''
  if (step === 'month') {
    const [y, m] = p.split('-')
    return `${MONTHS_FULL[Number(m) - 1]} ${y}`
  }
  const [y, m, d] = p.split('-')
  return `${d}.${m}.${y}`
}

const compareName = (mode) => (mode === 'year' ? 'год назад' : 'прошлый период')

// Красивые границы оси с учётом минуса (прибыль бывает отрицательной)
const niceStep = (span) => {
  const raw = span / 4
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const n = raw / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow
}

// Поля графика. Ширина берётся настоящая, а не масштабом viewBox: иначе на
// плитке в полэкрана подписи осей ужимались до нечитаемых 6px
const M = { top: 14, right: 16, bottom: 28, left: 64 }

export default function TrendWidget({ widget, range, project, today }) {
  const indicators = widget.indicators?.length ? widget.indicators : ['revenue']
  const [state, setState] = useState({ data: null, error: false })
  const sig = [range.from, range.to, project, widget.step, widget.compare, indicators.join(',')].join('|')

  useEffect(() => {
    let alive = true
    setState(s => ({ data: s.data, error: false, loading: true }))
    getIndicatorSeries({
      date_from: range.from, date_to: range.to,
      step: widget.step || 'auto', compare: widget.compare || 'none',
      indicators, ...(project ? { project_id: project } : {}),
    })
      .then(r => { if (alive) setState({ data: r.data, error: false }) })
      .catch(() => { if (alive) setState({ data: null, error: true }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  if (state.error) {
    return <div className="px-5 py-6 text-sm text-gray-500">Не удалось загрузить. Это не значит, что данных нет — обновите страницу.</div>
  }
  if (!state.data) {
    return <div className="p-5"><div className="h-56 rounded-lg bg-gray-100 animate-pulse" /></div>
  }
  return <TrendChart data={state.data} indicators={indicators} view={widget.view || 'auto'} today={today} dim={state.loading} />
}

function TrendChart({ data, indicators, view, today, dim }) {
  const svgRef = useRef(null)
  const boxRef = useRef(null)
  const [VB_W, setW] = useState(800)
  const ready = indicators.some(k => Array.isArray(data.series[k]))
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready])
  const VB_H = Math.round(Math.min(320, Math.max(210, VB_W * 0.3)))
  const X0 = M.left, X1 = VB_W - M.right, Y0 = M.top, Y1 = VB_H - M.bottom
  const [hover, setHover] = useState(null)
  const { points, step, compare } = data
  const shown = indicators.filter(k => Array.isArray(data.series[k]))
  const hidden = data.hidden || []
  const n = points.length
  const asBars = view === 'bar' || (view === 'auto' && step === 'month')

  // Будущее не рисуем: линия текущего месяца, упавшая в ноль после сегодня,
  // читалась бы как обвал продаж
  const lastReal = useMemo(() => {
    const cut = step === 'month' ? today.slice(0, 7) : today
    let k = n - 1
    while (k > 0 && points[k] > cut) k--
    return k
  }, [points, step, today, n])
  const cur = (key, i) => (i > lastReal ? null : data.series[key]?.[i] ?? null)
  const cmp = (key, i) => compare?.series?.[key]?.[i] ?? null

  // Ось Y по всем видимым значениям, включая сравнение
  const vals = []
  shown.forEach(k => {
    for (let i = 0; i < n; i++) {
      const a = cur(k, i); if (a != null) vals.push(a)
      const b = cmp(k, i); if (b != null) vals.push(b)
    }
  })
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals)
  const st = niceStep((hi - lo) || 1)
  const yMin = Math.floor(lo / st) * st
  const yMax = Math.max(Math.ceil(hi / st) * st, yMin + st)
  const yFor = (v) => Y1 - ((v - yMin) / (yMax - yMin)) * (Y1 - Y0)
  const ticks = []
  for (let v = yMin; v <= yMax + st / 2; v += st) ticks.push(v)

  // X: у столбцов — середина ячейки, у линий — от края до края
  const slot = (X1 - X0) / Math.max(n, 1)
  const xFor = (i) => asBars ? X0 + slot * (i + 0.5) : (n <= 1 ? (X0 + X1) / 2 : X0 + (i / (n - 1)) * (X1 - X0))
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor((X1 - X0) / (asBars ? 56 : 72)))))
  const multiYear = step === 'month' && points[0]?.slice(0, 4) !== points[n - 1]?.slice(0, 4)

  const linePath = (get) => {
    let d = '', pen = false
    for (let i = 0; i < n; i++) {
      const v = get(i)
      if (v == null) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)} `
      pen = true
    }
    return d
  }

  const onMove = (e) => {
    if (!svgRef.current || !n) return
    const rect = svgRef.current.getBoundingClientRect()
    const vx = ((e.clientX - rect.left) / rect.width) * VB_W
    let i = asBars ? Math.floor((vx - X0) / slot) : Math.round(((vx - X0) / (X1 - X0)) * (n - 1))
    i = Math.max(0, Math.min(n - 1, i))
    setHover({ i, px: (xFor(i) / VB_W) * rect.width, w: rect.width })
  }

  // Итоги периода — над графиком: сначала цифра, потом форма
  const total = (get) => { let s = 0; for (let i = 0; i < n; i++) s += get(i) ?? 0; return s }
  // Сравниваем честно: тот же отрезок, что уже прошёл (1–15 ноября против 1–15 октября)
  const cmpTotal = (k) => { let s = 0; for (let i = 0; i <= lastReal; i++) s += cmp(k, i) ?? 0; return s }

  const barW = asBars ? Math.min(28, (slot * 0.78) / Math.max(shown.length, 1)) : 0
  const groupW = barW * shown.length
  const zeroY = yFor(0)

  if (!shown.length) {
    return <div className="px-5 py-10 text-sm text-gray-500 text-center">
      {hidden.length ? 'Выбранные показатели закрыты для вашей должности' : 'Выберите показатели в настройках плитки'}
    </div>
  }

  return (
    <div className={`px-4 pt-3 pb-4 transition-opacity ${dim ? 'opacity-60' : ''}`}>
      {/* Итоги */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 px-1 pb-3">
        {shown.map(k => {
          const t = total(i => cur(k, i))
          const c = compare ? cmpTotal(k) : null
          const delta = c ? ((t - c) / Math.abs(c)) * 100 : null
          // Для себестоимости и расходов рост — плохо, для выручки и прибыли — хорошо
          const good = delta == null ? null : (k === 'cogs' || k === 'expenses') ? delta <= 0 : delta >= 0
          return (
            <div key={k} className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: META[k].color }} />
                {META[k].label}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-semibold text-gray-900 tabular-nums">{moneyShort(t)}</span>
                {delta != null && Number.isFinite(delta) && (
                  <span className={`text-xs font-medium tabular-nums ${good ? 'text-emerald-700' : 'text-red-600'}`}
                    title={`${compareName(compare.mode)}: ${money(c, { kopecks: false })}`}>
                    {percent(delta, { plus: true })}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="relative" ref={boxRef}>
        <svg ref={svgRef} viewBox={`0 0 ${VB_W} ${VB_H}`} width={VB_W} height={VB_H} className="block select-none"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
          aria-label={`График: ${shown.map(k => META[k].label).join(', ')}`}>
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={X0} x2={X1} y1={yFor(v)} y2={yFor(v)} stroke={v === 0 ? '#c3c2b7' : '#ebeae4'} strokeWidth="1" />
              <text x={X0 - 8} y={yFor(v) + 4} textAnchor="end" fontSize="11" fill="#898781">{moneyShort(v, { sign: false })}</text>
            </g>
          ))}
          {points.map((p, i) => (i % every === 0 || i === n - 1) && (i % every === 0 || n - 1 - i >= every / 2) && (
            <text key={p} x={xFor(i)} y={Y1 + 18} textAnchor="middle" fontSize="11" fill="#898781">
              {pointLabel(p, step, multiYear || (step === 'month' && i === 0))}
            </text>
          ))}

          {hover && (asBars
            ? <rect x={X0 + slot * hover.i} y={Y0} width={slot} height={Y1 - Y0} fill="#1e3a8a" opacity="0.05" />
            : <line x1={xFor(hover.i)} x2={xFor(hover.i)} y1={Y0} y2={Y1} stroke="#c3c2b7" strokeDasharray="3 3" />)}

          {/* Столбцы текущего периода */}
          {asBars && shown.map((k, j) => points.map((p, i) => {
            const v = cur(k, i)
            if (v == null) return null
            const x = xFor(i) - groupW / 2 + j * barW
            const y = Math.min(yFor(v), zeroY)
            return <rect key={k + p} x={x + 1} y={y} width={Math.max(barW - 2, 1)} height={Math.max(Math.abs(yFor(v) - zeroY), 0.5)}
              rx="2" fill={META[k].color} opacity={hover && hover.i !== i ? 0.55 : 1} />
          }))}

          {/* Сравнение — пунктиром того же цвета */}
          {compare && shown.map(k => (
            <path key={'c' + k} d={linePath(i => cmp(k, i))} fill="none" stroke={META[k].color}
              strokeWidth="1.75" strokeDasharray="5 4" opacity="0.65" strokeLinejoin="round" />
          ))}
          {compare && asBars && shown.map(k => points.map((p, i) => cmp(k, i) != null && (
            <circle key={'cd' + k + p} cx={xFor(i)} cy={yFor(cmp(k, i))} r="2.5" fill="#fff" stroke={META[k].color} strokeWidth="1.5" opacity="0.8" />
          )))}

          {/* Линии текущего периода */}
          {!asBars && shown.map(k => (
            <path key={k} d={linePath(i => cur(k, i))} fill="none" stroke={META[k].color} strokeWidth="2.25"
              strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {!asBars && n <= 40 && shown.map(k => points.map((p, i) => cur(k, i) != null && (
            <circle key={'d' + k + p} cx={xFor(i)} cy={yFor(cur(k, i))} r={hover?.i === i ? 4 : 2.5}
              fill="#fff" stroke={META[k].color} strokeWidth="2" />
          )))}
          {!asBars && n > 40 && hover && shown.map(k => cur(k, hover.i) != null && (
            <circle key={'h' + k} cx={xFor(hover.i)} cy={yFor(cur(k, hover.i))} r="4" fill="#fff" stroke={META[k].color} strokeWidth="2" />
          ))}
        </svg>

        {hover && (
          <div className="pointer-events-none absolute top-1 z-10 bg-white border border-gray-200 rounded-lg shadow-pop px-3 py-2 text-xs min-w-52"
            style={{ left: Math.min(Math.max(hover.px - 104, 4), hover.w - 220) }}>
            <div className="font-medium text-gray-800 mb-1.5 first-letter:uppercase">
              {pointTitle(points[hover.i], step)}
              {compare?.points?.[hover.i] && (
                <span className="font-normal text-gray-500"> · против {pointTitle(compare.points[hover.i], step)}</span>
              )}
            </div>
            {shown.map(k => {
              const a = cur(k, hover.i), b = cmp(k, hover.i)
              const d = compare && a != null && b ? ((a - b) / Math.abs(b)) * 100 : null
              return (
                <div key={k} className="flex items-center justify-between gap-4 py-0.5">
                  <span className="flex items-center gap-1.5 text-gray-600">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: META[k].color }} />{META[k].label}
                  </span>
                  <span className="tabular-nums text-right">
                    <span className="font-medium text-gray-900">{a == null ? '—' : money(a, { kopecks: false })}</span>
                    {compare && <span className="text-gray-400"> / {b == null ? '—' : moneyShort(b)}</span>}
                    {d != null && Number.isFinite(d) && <span className="ml-1 text-gray-500">{percent(d, { plus: true })}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Легенда: цвета показателей уже в итогах сверху — здесь только про пунктир */}
      {(compare || hidden.length > 0) && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-2 text-xs text-gray-500">
        {compare && (
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden="true"><line x1="0" x2="22" y1="3" y2="3" stroke="#898781" strokeWidth="1.75" strokeDasharray="5 4" /></svg>
            {compare.mode === 'year' ? 'Год назад' : 'Прошлый период'}: {pointTitle(compare.date_from, 'day')} — {pointTitle(compare.date_to, 'day')}
          </span>
        )}
        {hidden.length > 0 && <span>Закрыто для вашей должности: {hidden.map(k => META[k]?.label).join(', ')}</span>}
      </div>}
    </div>
  )
}
