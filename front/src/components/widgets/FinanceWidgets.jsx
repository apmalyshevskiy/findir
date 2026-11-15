import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { getDashboardCash, getBudgetProgress, getUpcomingPayments } from '../../api/dashboard'
import { money, percent, dateShort } from '../../utils/format'

/**
 * Плитки про деньги, план и платежи.
 *
 * Дашборд показывал выручку и себестоимость — показатели прошедшего периода.
 * Но открывают его с другими вопросами: сколько денег сейчас, идём ли по
 * плану и что платить на этой неделе. Ответы были, только в трёх разных
 * отчётах.
 *
 * Каждая плитка сама ходит за своими данными: у них нет общего периода с
 * показателями — остаток берётся на сегодня, план на текущий месяц, платежи
 * на две недели вперёд.
 */

const rub = (v) => money(v, { kopecks: false })

/** Состояния, общие для трёх плиток: грузится, не загрузилось, недоступно */
function useWidgetData(load, deps) {
  const [state, setState] = useState({ data: null, error: false })

  useEffect(() => {
    let alive = true
    load()
      .then(r => { if (alive) setState({ data: r.data, error: false }) })
      .catch(() => { if (alive) setState({ data: null, error: true }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

function Skeleton({ rows = 3 }) {
  return (
    <div className="p-5 space-y-3" aria-hidden="true">
      <div className="h-8 w-44 rounded-lg bg-gray-100 animate-pulse" />
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-4 rounded bg-gray-100 animate-pulse" style={{ width: `${85 - i * 12}%` }} />)}
    </div>
  )
}

function Note({ children }) {
  return <div className="px-5 py-6 text-sm text-gray-500">{children}</div>
}

const FAILED = <Note>Не удалось загрузить. Это не значит, что данных нет — обновите страницу.</Note>

// ── Деньги ─────────────────────────────────────────────────────────────────
export function CashWidget({ today, project }) {
  const { data, error } = useWidgetData(
    () => getDashboardCash({ date: today, ...(project ? { project_id: project } : {}) }),
    [today, project],
  )

  if (error) return FAILED
  if (!data) return <Skeleton />
  // Счёт денег закрыт должностью: прочерк, а не ноль — ноль читался бы как «денег нет»
  if (data.hidden) return <Note>Остатки денег закрыты вашей должностью.</Note>

  const max = Math.max(1, ...data.items.map(i => Math.abs(i.balance)))

  return (
    <div className="p-5">
      <p className={`text-[1.75rem] leading-9 font-semibold tracking-tight tabular-nums ${data.total < 0 ? 'text-red-600' : 'text-gray-900'}`}>
        {rub(data.total)}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        С начала месяца{' '}
        <span className={`font-medium tabular-nums ${data.month_change < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
          {data.month_change > 0 ? '+' : ''}{rub(data.month_change)}
        </span>
      </p>

      {data.items.length > 0 && (
        <ul className="mt-4 pt-3 border-t border-gray-100 space-y-2.5">
          {data.items.map(i => (
            <li key={i.id ?? 'none'}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-gray-600" title={i.name}>{i.name}</span>
                <span className={`font-medium tabular-nums shrink-0 ${i.balance < 0 ? 'text-red-600' : 'text-gray-800'}`}>{rub(i.balance)}</span>
              </div>
              {/* Полоска — доля кассы среди остальных: где лежат деньги, видно
                  без чтения цифр. Минус — красной */}
              <div className="mt-1 h-1 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full rounded-full ${i.balance < 0 ? 'bg-red-400' : 'bg-brand-600'}`}
                  style={{ width: `${Math.max(2, Math.abs(i.balance) / max * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── План и факт месяца ─────────────────────────────────────────────────────
const monthName = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '')

function PlanFactRow({ label, plan, fact, lessIsBetter, strong }) {
  const done = plan > 0 && fact != null ? fact / plan * 100 : null
  // Выручка выше плана — хорошо; расходы выше плана — перерасход
  const over = done != null && done > 100
  const tone = done == null ? 'bg-gray-300'
    : lessIsBetter ? (over ? 'bg-red-500' : 'bg-brand-600')
    : (over ? 'bg-emerald-500' : 'bg-brand-600')

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-sm ${strong ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>{label}</span>
        <span className="text-sm tabular-nums shrink-0">
          <span className={`font-medium ${strong && fact < 0 ? 'text-red-600' : 'text-gray-900'}`}>{fact == null ? '—' : rub(fact)}</span>
          <span className="text-gray-400"> из {rub(plan)}</span>
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="relative flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, done ?? 0))}%` }} />
        </div>
        <span className={`w-11 text-right text-xs tabular-nums ${
          done == null ? 'text-gray-400' : lessIsBetter && over ? 'text-red-600 font-medium' : !lessIsBetter && over ? 'text-emerald-700 font-medium' : 'text-gray-500'}`}>
          {done == null ? '—' : percent(done, { digits: 0 })}
        </span>
      </div>
    </div>
  )
}

export function BudgetProgressWidget({ today }) {
  const { data, error } = useWidgetData(() => getBudgetProgress({ date: today }), [today])

  if (error) return FAILED
  if (!data) return <Skeleton rows={4} />
  if (!data.available) {
    return (
      <Note>
        {data.reason === 'forbidden'
          ? 'Бюджет закрыт вашей должностью.'
          : <>На этот месяц бюджета нет. <Link to="/budget" className="font-medium text-brand-700 hover:underline">Составить бюджет</Link></>}
      </Note>
    )
  }

  return (
    <div className="p-5 space-y-4">
      {data.sections.map(s => (
        <PlanFactRow key={s.key} label={s.label} plan={s.plan} fact={s.fact} lessIsBetter={s.key !== 'revenue'} />
      ))}
      <div className="pt-4 border-t border-gray-100">
        <PlanFactRow label="Прибыль" plan={data.profit.plan} fact={data.profit.fact} strong />
      </div>
      <p className="text-xs text-gray-500">
        {monthName(data.month)} · {data.document.name}{data.document.status !== 'approved' ? ' (черновик)' : ''}
      </p>
    </div>
  )
}

// ── Ближайшие платежи ──────────────────────────────────────────────────────
export function UpcomingPaymentsWidget({ today }) {
  const { data, error } = useWidgetData(() => getUpcomingPayments({ date: today }), [today])

  if (error) return FAILED
  if (!data) return <Skeleton rows={4} />
  if (!data.available) {
    return (
      <Note>
        {data.reason === 'forbidden'
          ? 'Платёжный календарь закрыт вашей должностью.'
          : <>На ближайшие две недели календаря нет. <Link to="/payment-calendar" className="font-medium text-brand-700 hover:underline">Открыть платёжный календарь</Link></>}
      </Note>
    )
  }

  const net = data.inflow - data.outflow

  return (
    <div className="p-5">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-2xs font-medium uppercase tracking-wider text-gray-500">Придёт</p>
          <p className="mt-0.5 text-base font-semibold text-emerald-700 tabular-nums">{rub(data.inflow)}</p>
        </div>
        <div>
          <p className="text-2xs font-medium uppercase tracking-wider text-gray-500">Платить</p>
          <p className="mt-0.5 text-base font-semibold text-gray-900 tabular-nums">{rub(data.outflow)}</p>
        </div>
        <div>
          <p className="text-2xs font-medium uppercase tracking-wider text-gray-500">Итог</p>
          <p className={`mt-0.5 text-base font-semibold tabular-nums ${net < 0 ? 'text-red-600' : 'text-gray-900'}`}>{net > 0 ? '+' : ''}{rub(net)}</p>
        </div>
      </div>

      {data.items.length === 0 ? (
        <p className="mt-4 pt-3 border-t border-gray-100 text-sm text-gray-500">На две недели платежей не запланировано.</p>
      ) : (
        <ul className="mt-4 pt-1 border-t border-gray-100 divide-y divide-gray-100">
          {data.items.map(i => {
            const income = i.amount > 0
            const Icon = income ? ArrowDownLeft : ArrowUpRight
            return (
              <li key={i.id} className="flex items-center gap-3 py-2">
                <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${income ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'}`}>
                  <Icon className="w-4 h-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-gray-800 truncate" title={i.title}>{i.title}</span>
                  <span className="block text-xs text-gray-500">{dateShort(i.date)}{i.article && i.article !== i.title ? ` · ${i.article}` : ''}</span>
                </span>
                <span className={`text-sm font-medium tabular-nums shrink-0 ${income ? 'text-emerald-700' : 'text-gray-900'}`}>
                  {income ? '+' : '−'}{rub(Math.abs(i.amount))}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {data.count > data.items.length && (
        <p className="mt-2 text-xs text-gray-500">Показаны первые {data.items.length} из {data.count}</p>
      )}
    </div>
  )
}
