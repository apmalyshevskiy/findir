import { useEffect, useState } from 'react'
import {
  PRESETS, MONTHS, MONTHS_SHORT, QUARTERS,
  presetRange, monthRange, quarterRange, yearRange,
  matchesMonth, matchesQuarter, matchesYear,
  periodLabel, periodYear, localDate,
} from '../utils/period'

/**
 * Выбор периода: типовой и произвольный — рядом, а не один внутри другого.
 *
 *   [‹] [📅 Август 2026 ▾] [›]  │  с [дата] по [дата]
 *
 * Слева — типовые периоды: пресеты и календарная сетка, где месяц/квартал/год
 * одним кликом задают обе даты. Справа — всегда видимые поля для произвольного
 * отрезка. Стрелки листают текущий период целиком: месяц → предыдущий месяц,
 * квартал → предыдущий квартал, произвольный отрезок — на свою длину.
 *
 * value: { from, to, preset } — preset хранит «Месяц»/«Квартал» и т.п., чтобы
 * период пересчитывался от сегодняшней даты; конкретный выбор — 'custom'.
 */
export default function PeriodPicker({ value, onChange, allowAll = false, align = 'left' }) {
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(() => periodYear(value))
  const [mode, setMode] = useState('month') // 'month' | 'quarter'

  // Открываем выбор на том годе и в том режиме, что показывает текущий период
  useEffect(() => {
    if (!open) return
    const y = periodYear(value)
    setYear(y)
    setMode(QUARTERS.some((_, q) => matchesQuarter(value, y, q)) ? 'quarter' : 'month')
  }, [open])

  const presets = allowAll ? PRESETS : PRESETS.filter(p => p.key !== 'all')

  const pick = (range, preset = 'custom') => {
    onChange({ ...range, preset })
    setOpen(false)
  }

  // Правка одной границы. Если диапазон вывернулся (начало позже конца) —
  // подтягиваем вторую границу, а не блокируем ввод: иначе сдвинуть период
  // вперёд было бы нельзя, «с» упиралось бы в старое «по».
  const setEdge = (edge, val) => {
    const next = { ...value, [edge]: val, preset: 'custom' }
    if (next.from && next.to && next.from > next.to) {
      if (edge === 'from') next.to = val
      else next.from = val
    }
    onChange(next)
  }

  // Шаг назад/вперёд по текущему периоду
  const shift = (dir) => {
    const y = periodYear(value)

    for (let m = 0; m < 12; m++) {
      if (matchesMonth(value, y, m)) return pick(monthRange(y, m + dir))
    }
    for (let q = 0; q < 4; q++) {
      if (matchesQuarter(value, y, q)) {
        const nq = q + dir
        return pick(quarterRange(y + Math.floor(nq / 4), ((nq % 4) + 4) % 4))
      }
    }
    if (matchesYear(value, y)) return pick(yearRange(y + dir))

    // Произвольный диапазон — сдвигаем на его длину.
    // Даты собираем покомпонентно: new Date('2026-08-01') разбирается как UTC
    // и в минусовых поясах уезжает на сутки назад.
    if (value.from && value.to) {
      const [fy, fm, fd] = value.from.split('-').map(Number)
      const [ty, tm, td] = value.to.split('-').map(Number)
      const from = new Date(fy, fm - 1, fd)
      const to   = new Date(ty, tm - 1, td)
      const days = Math.round((to - from) / 86400000) + 1
      from.setDate(from.getDate() + dir * days)
      to.setDate(to.getDate() + dir * days)
      return pick({ from: localDate(from), to: localDate(to) })
    }
  }

  const canShift = !!(value.from && value.to)

  // Подпись кнопки. Для произвольного отрезка не дублируем даты — они видны
  // в полях справа.
  const y0 = periodYear(value)
  const isNamed = (!value.from && !value.to)
    || matchesYear(value, y0)
    || MONTHS.some((_, m) => matchesMonth(value, y0, m))
    || QUARTERS.some((_, q) => matchesQuarter(value, y0, q))
  const label = isNamed ? periodLabel(value) : 'Произвольный'

  const cell = 'px-2 py-1.5 rounded-lg text-xs font-medium transition-colors'
  const dateInput = 'px-2 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* ── Типовой период ── */}
      <div className="relative inline-flex items-center gap-0.5">
        <button type="button" onClick={() => canShift && shift(-1)} disabled={!canShift}
          title="Предыдущий период"
          className="px-1.5 py-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400">
          ‹
        </button>

        <button type="button" onClick={() => setOpen(o => !o)}
          className={`flex items-center gap-2 px-3 py-1 border rounded-lg text-sm transition-colors ${
            open ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300'
          }`}>
          <svg className="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          <span className={`whitespace-nowrap ${isNamed ? 'text-gray-800' : 'text-gray-500'}`}>{label}</span>
          <svg className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
        </button>

        <button type="button" onClick={() => canShift && shift(1)} disabled={!canShift}
          title="Следующий период"
          className="px-1.5 py-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400">
          ›
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} />
            <div className={`absolute top-full mt-1.5 z-[60] w-[20rem] bg-white border border-gray-200 rounded-xl shadow-lg p-3 space-y-3 ${
              align === 'right' ? 'right-0' : 'left-0'
            }`}>
              {/* Пресеты от сегодняшней даты */}
              <div className="flex flex-wrap gap-1.5">
                {presets.map(p => (
                  <button key={p.key} type="button"
                    onClick={() => pick(presetRange(p.key), p.key)}
                    className={`${cell} ${
                      value.preset === p.key ? 'bg-blue-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}>
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="border-t border-gray-100 pt-3">
                {/* Год + переключатель месяц/квартал */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setYear(y => y - 1)}
                      className="px-1.5 text-gray-400 hover:text-gray-700">‹</button>
                    <button type="button" onClick={() => pick(yearRange(year))}
                      title="Весь год"
                      className={`px-2 py-1 rounded-lg text-sm font-semibold transition-colors ${
                        matchesYear(value, year) ? 'bg-blue-900 text-white' : 'text-gray-700 hover:bg-gray-100'
                      }`}>
                      {year}
                    </button>
                    <button type="button" onClick={() => setYear(y => y + 1)}
                      className="px-1.5 text-gray-400 hover:text-gray-700">›</button>
                  </div>

                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
                    {[{ key: 'month', label: 'Месяцы' }, { key: 'quarter', label: 'Кварталы' }].map(m => (
                      <button key={m.key} type="button" onClick={() => setMode(m.key)}
                        className={`px-2.5 py-1 transition-colors ${
                          mode === m.key ? 'bg-gray-800 text-white' : 'text-gray-500 hover:bg-gray-50'
                        }`}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Календарная сетка: один клик — обе даты */}
                <div className="grid grid-cols-4 gap-1">
                  {mode === 'month'
                    ? MONTHS_SHORT.map((lbl, m) => (
                        <button key={m} type="button" onClick={() => pick(monthRange(year, m))}
                          className={`${cell} ${
                            matchesMonth(value, year, m)
                              ? 'bg-blue-900 text-white'
                              : 'text-gray-600 hover:bg-blue-50 hover:text-blue-700'
                          }`}>
                          {lbl}
                        </button>
                      ))
                    : QUARTERS.map((lbl, q) => (
                        <button key={q} type="button" onClick={() => pick(quarterRange(year, q))}
                          className={`${cell} ${
                            matchesQuarter(value, year, q)
                              ? 'bg-blue-900 text-white'
                              : 'text-gray-600 hover:bg-blue-50 hover:text-blue-700'
                          }`}>
                          {lbl}
                        </button>
                      ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Произвольный период: всегда под рукой, без открытия выпадашки ── */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-gray-400">с</span>
        <input type="date" value={value.from || ''}
          onChange={e => setEdge('from', e.target.value)}
          className={dateInput} />
        <span className="text-xs text-gray-400">по</span>
        <input type="date" value={value.to || ''}
          onChange={e => setEdge('to', e.target.value)}
          className={dateInput} />
      </div>
    </div>
  )
}
