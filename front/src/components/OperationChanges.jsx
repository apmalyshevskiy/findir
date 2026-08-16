import { useEffect, useState } from 'react'
import { getOperationChanges } from '../api/operations'

/**
 * Движения по счетам, которые дала операция.
 *
 * Это содержимое balance_changes — единственное, что видят отчёты. Операция
 * лишь порождает эти строки триггером, поэтому вопрос «почему в оборотке
 * такая цифра» разрешается именно здесь.
 */

const money = (v) => Number(v ?? 0).toLocaleString('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})

const qty = (v) => Number(v ?? 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 })

const SIDE = {
  debit:  { label: 'Дебет',  cls: 'bg-green-50 text-green-700 ring-green-200' },
  credit: { label: 'Кредит', cls: 'bg-red-50 text-red-700 ring-red-200' },
}

export default function OperationChanges({ operationId }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    getOperationChanges(operationId)
      .then(r => { if (alive) setState(r.data) })
      .catch(() => { if (alive) setError('Не удалось получить движения') })
    return () => { alive = false }
  }, [operationId])

  if (error)   return <div className="text-sm text-red-600">{error}</div>
  if (!state)  return <div className="text-sm text-gray-400">Загружаю...</div>

  const rows = state.data || []

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div className="border border-amber-200 bg-amber-50/60 rounded-lg px-4 py-3 text-sm text-amber-900">
          {state.is_posted
            ? 'Движений нет. Такое бывает у удалённой операции — отчёты её не видят.'
            : 'Операция не проведена, поэтому движений по счетам нет и в обороты она не входит.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="py-1.5 pr-3 font-medium">Сторона</th>
                <th className="py-1.5 pr-3 font-medium">Счёт</th>
                <th className="py-1.5 pr-3 font-medium">Аналитика</th>
                <th className="py-1.5 pr-3 font-medium text-right">Сумма</th>
                <th className="py-1.5 font-medium text-right">Кол-во</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => {
                const s = SIDE[r.side] || SIDE.debit
                const analytics = [r.info_1_name, r.info_2_name, r.info_3_name].filter(Boolean)
                return (
                  <tr key={k} className="border-t border-gray-100 align-top">
                    <td className="py-2 pr-3">
                      <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ring-1 ${s.cls}`}>
                        {s.label}
                      </span>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className="font-mono text-gray-700">{r.bi_code}</span>{' '}
                      <span className="text-gray-500">{r.bi_name}</span>
                    </td>
                    <td className="py-2 pr-3 text-gray-500">
                      {analytics.length ? analytics.join(' · ') : '—'}
                    </td>
                    <td className={`py-2 pr-3 text-right tabular-nums font-medium ${
                      r.amount < 0 ? 'text-amber-700' : 'text-gray-800'
                    }`}>
                      {money(r.amount)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-blue-600">
                      {Number(r.quantity) ? qty(r.quantity) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-gray-400 leading-relaxed">
        Знак суммы здесь — направление движения по счёту: сальдо счёта складывается
        из этих чисел. Сторона (дебет или кредит) берётся из проводки и от знака
        не зависит — поэтому сторно с минусом уменьшает оборот по своей стороне,
        а не создаёт встречный.
      </p>
    </div>
  )
}
