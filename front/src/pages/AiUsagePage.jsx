import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import { SkeletonRows } from '../components/Busy'
import api from '../api/client'

/**
 * Расход на ИИ.
 *
 * Шлюз возвращает и токены, и стоимость каждого вызова — здесь они собраны за
 * период. Показываем себестоимость: наценка задаётся настройкой и сейчас
 * нулевая, то есть ровно то, во что обошёлся шлюз.
 */

const money = (v, currency) => {
  const n = Number(v || 0)
  // Расход на один вызов — копейки, поэтому знаков после запятой больше
  // обычного: округление до копейки превратило бы половину строк в нули
  const digits = n > 0 && n < 1 ? 4 : 2
  return n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    + (currency === 'RUB' ? ' ₽' : ` ${currency || ''}`)
}

const num = (v) => Number(v || 0).toLocaleString('ru-RU')

const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` }
const today = () => new Date().toISOString().slice(0, 10)

const fmtDateTime = (s) => {
  if (!s) return '—'
  const d = new Date(String(s).replace(' ', 'T'))
  return isNaN(d) ? s : d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export default function AiUsagePage() {
  const [from, setFrom] = useState(monthStart)
  const [to, setTo]     = useState(today)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    api.get('/ai/usage', { params: { date_from: from, date_to: to } })
      .then(r => { if (alive) setData(r.data) })
      .catch(e => { if (alive) setError(e.response?.data?.message || 'Не удалось получить расход') })
    return () => { alive = false }
  }, [from, to])

  const currency = data?.totals?.currency
  const markup   = data?.markup || 0
  // Наценка применяется при показе: в журнале лежит себестоимость, и смена
  // наценки не должна переписывать историю
  const withMarkup = (v) => Number(v || 0) * (1 + markup / 100)

  const ic = 'px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <Layout>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Расход на ИИ</h1>
          <p className="text-sm text-gray-500 mt-1">
            Токены и стоимость по данным шлюза. {markup > 0
              ? `Показано с наценкой ${markup}%.`
              : 'Показана себестоимость — без наценки.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className={ic} value={from} onChange={e => setFrom(e.target.value)} />
          <span className="text-gray-300">—</span>
          <input type="date" className={ic} value={to} onChange={e => setTo(e.target.value)} />
        </div>
      </div>

      {error && <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{error}</div>}

      {data === null ? (
        <SkeletonRows rows={5} height="h-16" />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Стоимость за период</p>
              <p className="text-3xl font-bold text-gray-800">
                {money(withMarkup(data.totals.cost), currency)}
              </p>
              {data.totals.without_cost > 0 && (
                <p className="text-[11px] text-amber-600 mt-1">
                  {data.totals.without_cost} вызовов без цены от шлюза — в сумму не вошли
                </p>
              )}
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Токенов</p>
              <p className="text-3xl font-bold text-blue-600">{num(data.totals.total_tokens)}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Обращений к ИИ</p>
              <p className="text-3xl font-bold text-gray-800">{num(data.totals.calls)}</p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mb-6">
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 text-sm font-semibold text-gray-700">
              По видам работ
            </div>
            {data.data.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-10">За период обращений к ИИ не было</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100">
                    <th className="text-left px-5 py-2">Что делали</th>
                    <th className="text-left px-5 py-2">Модель</th>
                    <th className="text-right px-5 py-2">Вызовов</th>
                    <th className="text-right px-5 py-2">Вход</th>
                    <th className="text-right px-5 py-2">Выход</th>
                    <th className="text-right px-5 py-2">Стоимость</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((r, i) => (
                    <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="px-5 py-2.5 text-gray-800">{data.labels[r.feature] || r.feature}</td>
                      <td className="px-5 py-2.5 text-xs font-mono text-gray-500">{r.model || '—'}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-gray-700">{num(r.calls)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-gray-500">{num(r.input_tokens)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-gray-500">{num(r.output_tokens)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums font-medium text-gray-800">
                        {r.cost == null ? <span className="text-gray-300">—</span> : money(withMarkup(r.cost), currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {data.recent.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 text-sm font-semibold text-gray-700">
                Последние обращения
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {data.recent.map(r => (
                    <tr key={r.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-5 py-2 text-xs text-gray-400 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                      <td className="px-5 py-2 text-gray-700">{data.labels[r.feature] || r.feature}</td>
                      <td className="px-5 py-2 text-xs font-mono text-gray-400">{r.model || '—'}</td>
                      <td className="px-5 py-2 text-right tabular-nums text-xs text-gray-500">
                        {num(r.input_tokens)} → {num(r.output_tokens)}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums text-gray-700 whitespace-nowrap">
                        {r.cost == null ? <span className="text-gray-300">—</span> : money(withMarkup(r.cost), currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Layout>
  )
}
