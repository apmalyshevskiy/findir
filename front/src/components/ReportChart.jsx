import { SERIES_PALETTE } from './RevenueChart'

const money = (v) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0)

const compact = (v) => {
  const a = Math.abs(v)
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' млн'
  if (a >= 1e3) return Math.round(v / 1e3) + ' тыс'
  return String(Math.round(v))
}

const color = (i) => SERIES_PALETTE[i % SERIES_PALETTE.length]

/**
 * График по строкам показателя.
 *
 * Три вида под три типа вопроса:
 *   bar   — «по статьям», сравнение категорий. Полосы горизонтальные:
 *           названия статей длинные, под вертикальными столбцами они не читаются.
 *   line  — «по месяцам», динамика во времени.
 *   donut — «структура», доли в целом. Только для однознаковых данных:
 *           доля от суммы, где часть значений отрицательна, смысла не имеет.
 */
export default function ReportChart({ type, rows }) {
  if (!rows?.length) return null

  if (type === 'line')  return <LineChart rows={rows} />
  if (type === 'donut') return <DonutChart rows={rows} />
  return <BarChart rows={rows} />
}

// ── Горизонтальные полосы ───────────────────────────────────────────────────
function BarChart({ rows }) {
  const max = Math.max(...rows.map(r => Math.abs(r.amount)), 1)

  return (
    <div className="space-y-1.5 mt-2">
      {rows.map((r, i) => (
        <div key={i}>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="text-gray-700 truncate" title={r.name}>{r.name}</span>
            <span className="text-gray-800 font-medium whitespace-nowrap">{money(r.amount)}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(2, (Math.abs(r.amount) / max) * 100)}%`, background: color(i) }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Линия по времени ────────────────────────────────────────────────────────
function LineChart({ rows }) {
  const W = 640, H = 200
  const M = { top: 12, right: 12, bottom: 26, left: 52 }
  const x0 = M.left, x1 = W - M.right, y0 = M.top, y1 = H - M.bottom

  const values = rows.map(r => r.amount)
  const maxV = Math.max(...values, 0)
  const minV = Math.min(...values, 0)
  const span = (maxV - minV) || 1

  const px = (i) => rows.length === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (rows.length - 1)
  const py = (v) => y1 - ((v - minV) / span) * (y1 - y0)

  const points = rows.map((r, i) => `${px(i)},${py(r.amount)}`).join(' ')
  const zeroY  = py(0)

  // Подписи по оси X прореживаем: «по дням» их могут быть сотни, и они
  // превратятся в сплошную серую полосу. Оставляем около десяти.
  const labelStep = Math.max(1, Math.ceil(rows.length / 10))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full mt-2" style={{ maxHeight: 200 }}>
      {/* Сетка: минимум, ноль, максимум */}
      {[maxV, minV].concat(minV < 0 ? [0] : []).map((v, i) => (
        <g key={i}>
          <line x1={x0} x2={x1} y1={py(v)} y2={py(v)} stroke="#e5e7eb" strokeWidth="1" />
          <text x={x0 - 6} y={py(v) + 3} textAnchor="end" fontSize="10" fill="#9ca3af">{compact(v)}</text>
        </g>
      ))}

      {minV < 0 && <line x1={x0} x2={x1} y1={zeroY} y2={zeroY} stroke="#d1d5db" strokeWidth="1" />}

      <polyline points={points} fill="none" stroke={SERIES_PALETTE[0]} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />

      {rows.map((r, i) => (
        <g key={i}>
          {/* Точки рисуем не всегда: на ряду по дням они сливаются в кашу */}
          {rows.length <= 60 && (
            <circle cx={px(i)} cy={py(r.amount)} r="3.5" fill="#fff" stroke={SERIES_PALETTE[0]} strokeWidth="2" />
          )}
          <title>{`${r.name}: ${money(r.amount)}`}</title>
          {i % labelStep === 0 && (
            <text x={px(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#9ca3af">
              {r.name.replace(/\s\d{4}$/, '')}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

// ── Кольцо (структура) ──────────────────────────────────────────────────────
function DonutChart({ rows }) {
  const total = rows.reduce((s, r) => s + Math.abs(r.amount), 0) || 1
  const R = 60, C = 2 * Math.PI * R

  let offset = 0
  const arcs = rows.map((r, i) => {
    const share = Math.abs(r.amount) / total
    const len = share * C
    const arc = { len, offset, color: color(i), share }
    offset += len
    return arc
  })

  return (
    <div className="flex items-center gap-4 mt-2 flex-wrap">
      <svg viewBox="0 0 160 160" className="w-32 h-32 flex-shrink-0" style={{ transform: 'rotate(-90deg)' }}>
        {arcs.map((a, i) => (
          <circle key={i} cx="80" cy="80" r={R} fill="none" stroke={a.color} strokeWidth="22"
            strokeDasharray={`${a.len} ${C - a.len}`} strokeDashoffset={-a.offset} />
        ))}
      </svg>

      <div className="flex-1 min-w-0 space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color(i) }} />
            <span className="text-gray-700 truncate flex-1" title={r.name}>{r.name}</span>
            <span className="text-gray-400">{Math.round(arcs[i].share * 100)}%</span>
            <span className="text-gray-800 font-medium whitespace-nowrap">{money(r.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
