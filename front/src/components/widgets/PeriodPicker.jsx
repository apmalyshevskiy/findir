import {
  HEADER_PERIOD_OPTIONS, WIDGET_PERIOD_OPTIONS,
  WEEK_OFFSETS, MONTH_OFFSETS, YEAR_OFFSETS,
  weekOffsetLabel, monthOffsetLabel, yearOffsetLabel,
} from './registry'

const sc = 'px-2 py-1 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500'

// Выбор периода: вид + параметр (дата / смещение / произвольный диапазон).
//   value    — {period, date, offset, from, to}
//   onChange — (patch) => void
//   allowInherit — показывать «Как в шапке»
export default function PeriodPicker({ value: p, onChange, allowInherit, today }) {
  const options = allowInherit ? WIDGET_PERIOD_OPTIONS : HEADER_PERIOD_OPTIONS
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select className={sc} value={p.period} onChange={e => onChange({ period: e.target.value })}>
        {options.map(o => <option key={o.key} value={o.key}>{o.title}</option>)}
      </select>

      {p.period === 'day' && (
        <input type="date" className={sc} value={p.date || today} onChange={e => onChange({ date: e.target.value })} />
      )}
      {p.period === 'week' && (
        <select className={sc} value={p.offset ?? 0} onChange={e => onChange({ offset: Number(e.target.value) })}>
          {WEEK_OFFSETS.map(o => <option key={o} value={o}>{weekOffsetLabel(o)}</option>)}
        </select>
      )}
      {p.period === 'month' && (
        <select className={sc} value={p.offset ?? 0} onChange={e => onChange({ offset: Number(e.target.value) })}>
          {MONTH_OFFSETS.map(o => <option key={o} value={o}>{monthOffsetLabel(o, today)}</option>)}
        </select>
      )}
      {p.period === 'year' && (
        <select className={sc} value={p.offset ?? 0} onChange={e => onChange({ offset: Number(e.target.value) })}>
          {YEAR_OFFSETS.map(o => <option key={o} value={o}>{yearOffsetLabel(o, today)}</option>)}
        </select>
      )}
      {p.period === 'custom' && (
        <span className="flex items-center gap-1.5">
          <input type="date" className={sc} value={p.from || today} onChange={e => onChange({ from: e.target.value })} />
          <span className="text-gray-400">—</span>
          <input type="date" className={sc} value={p.to || today} onChange={e => onChange({ to: e.target.value })} />
        </span>
      )}
    </div>
  )
}
