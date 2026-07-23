import { useRef, useState } from 'react'

// Категориальная палитра (light) из гайда по визуализации — фиксированный порядок.
export const SERIES_PALETTE = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
]
const OTHER_COLOR = '#898781'

// Геометрия viewBox (SVG масштабируется по ширине контейнера).
const VB_W = 800
const VB_H = 280
const M = { top: 14, right: 18, bottom: 26, left: 60 }
const PLOT_X0 = M.left
const PLOT_X1 = VB_W - M.right
const PLOT_Y0 = M.top
const PLOT_Y1 = VB_H - M.bottom
const PLOT_W = PLOT_X1 - PLOT_X0
const PLOT_H = PLOT_Y1 - PLOT_Y0

const fmtFull = (v) =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0)

const fmtCompact = (v) => {
  const a = Math.abs(v)
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' млн'
  if (a >= 1e3) return Math.round(v / 1e3) + ' тыс'
  return String(Math.round(v))
}

const fmtDay = (iso) => {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  return `${d}.${m}`
}

const niceMax = (x) => {
  if (x <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(x)))
  const n = x / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

// props:
//   days: string[] (YYYY-MM-DD)
//   projects: [{id, name, total}]  — только с данными, порядок для легенды
//   series: { [pid]: number[] }    — выровнено по days
//   colorMap: { [pid]: hex }
export default function RevenueChart({ days = [], projects = [], series = {}, colorMap = {} }) {
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null) // { i, px }

  const n = days.length
  const hasData = projects.length > 0 && n > 0

  const allVals = []
  projects.forEach(p => (series[p.id] || []).forEach(v => allVals.push(v)))
  const maxV = niceMax(Math.max(0, ...allVals))

  const xFor = (i) => (n <= 1 ? (PLOT_X0 + PLOT_W / 2) : PLOT_X0 + (i / (n - 1)) * PLOT_W)
  const yFor = (v) => PLOT_Y1 - (v / maxV) * PLOT_H

  const colorFor = (pid) => colorMap[pid] || OTHER_COLOR

  // Горизонтальные линии сетки и подписи оси Y
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: maxV * f, y: yFor(maxV * f) }))

  // Подписи оси X: не более ~7 меток
  const xEvery = Math.max(1, Math.ceil(n / 7))
  const xTicks = days.map((d, i) => ({ d, i })).filter(({ i }) => i % xEvery === 0 || i === n - 1)

  const pathFor = (pid) => {
    const vals = series[pid] || []
    return vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`).join(' ')
  }

  const onMove = (e) => {
    if (!svgRef.current || n === 0) return
    const rect = svgRef.current.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * VB_W
    let i = n <= 1 ? 0 : Math.round(((vbX - PLOT_X0) / PLOT_W) * (n - 1))
    i = Math.max(0, Math.min(n - 1, i))
    const px = (xFor(i) / VB_W) * rect.width
    setHover({ i, px })
  }

  if (!hasData) {
    return <div className="px-5 py-10 text-sm text-gray-400 text-center">Нет данных за период</div>
  }

  const multi = projects.length > 1

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full h-auto select-none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Сетка + подписи Y */}
        {yTicks.map(({ v, y }, idx) => (
          <g key={idx}>
            <line x1={PLOT_X0} x2={PLOT_X1} y1={y} y2={y} stroke={idx === 0 ? '#c3c2b7' : '#e1e0d9'} strokeWidth="1" />
            <text x={PLOT_X0 - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#898781">{fmtCompact(v)}</text>
          </g>
        ))}

        {/* Подписи X */}
        {xTicks.map(({ d, i }) => (
          <text key={i} x={xFor(i)} y={PLOT_Y1 + 16} textAnchor="middle" fontSize="11" fill="#898781">{fmtDay(d)}</text>
        ))}

        {/* Перекрестие */}
        {hover && (
          <line x1={xFor(hover.i)} x2={xFor(hover.i)} y1={PLOT_Y0} y2={PLOT_Y1} stroke="#c3c2b7" strokeWidth="1" strokeDasharray="3 3" />
        )}

        {/* Линии проектов */}
        {projects.map(p => (
          <path key={p.id} d={pathFor(p.id)} fill="none" stroke={colorFor(p.id)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* Точки на наведённом дне */}
        {hover && projects.map(p => (
          <circle key={p.id} cx={xFor(hover.i)} cy={yFor((series[p.id] || [])[hover.i] || 0)} r="4"
            fill="#fff" stroke={colorFor(p.id)} strokeWidth="2" />
        ))}
      </svg>

      {/* Подсказка */}
      {hover && (
        <div
          className="pointer-events-none absolute top-2 z-10 bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs"
          style={{ left: Math.min(Math.max(hover.px, 8), (svgRef.current?.clientWidth || VB_W) - 170), minWidth: 150 }}
        >
          <div className="font-medium text-gray-700 mb-1">{fmtDay(days[hover.i])}.{days[hover.i]?.slice(0, 4)}</div>
          {projects.map(p => (
            <div key={p.id} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-gray-600">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: colorFor(p.id) }} />
                {p.name}
              </span>
              <span className="font-medium text-gray-800 tabular-nums">{fmtFull((series[p.id] || [])[hover.i] || 0)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Легенда (для нескольких проектов) */}
      {multi && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 pt-2">
          {projects.map(p => (
            <span key={p.id} className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: colorFor(p.id) }} />
              {p.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
