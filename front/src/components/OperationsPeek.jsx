import { useEffect, useState } from 'react'
import { getOperations } from '../api/operations'
import { openObject } from './ObjectOpener'
import { SkeletonRows } from './Busy'

/**
 * Расшифровка суммы: из каких операций она сложилась.
 *
 * Общая на отчёты, где цифра кликабельна. Сама операция открывается поверх
 * списка через ObjectOpener — своей формы здесь нет намеренно: их в проекте уже
 * две, и третья разошлась бы с ними на первой же правке.
 *
 * `filter` нужен там, где отбор сервера шире отчёта: в ОДДС статья ДДС может
 * стоять и на неденежной стороне, а в отчёт идут только денежные счета.
 */
export default function OperationsPeek({ title, subtitle, params, filter, onClose }) {
  const [ops, setOps]         = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const load = () => {
    setLoading(true); setError('')

    getOperations({ per_page: 300, ...params })
      .then(r => {
        const rows = r.data.data || []
        setOps(filter ? rows.filter(filter) : rows)
      })
      .catch(e => setError(e.response?.data?.message || 'Не удалось загрузить операции'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [JSON.stringify(params)])

  const money = (v) => Number(v ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const day   = (d) => String(d || '').slice(0, 10).split('-').reverse().join('.')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col"
        onMouseDown={e => e.stopPropagation()}>

        <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-gray-800">{title}</h3>
            {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto p-5">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
          {loading && !ops && <SkeletonRows rows={6} />}

          {ops && ops.length === 0 && !loading && (
            <div className="text-center py-10 text-sm text-gray-400">Операций не найдено</div>
          )}

          {ops && ops.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-100">
                  <th className="text-left font-medium py-2 pr-3">#</th>
                  <th className="text-left font-medium py-2 pr-3">Дата</th>
                  <th className="text-left font-medium py-2 pr-3">Дебет</th>
                  <th className="text-left font-medium py-2 pr-3">Кредит</th>
                  <th className="text-right font-medium py-2 pr-3">Сумма</th>
                  <th className="text-left font-medium py-2">Содержание</th>
                </tr>
              </thead>
              <tbody>
                {ops.map(op => (
                  <tr key={op.id}
                    onClick={() => openObject('operation', op.id)}
                    className="border-b border-gray-50 hover:bg-blue-50/60 cursor-pointer"
                    title="Открыть операцию">
                    <td className="py-2 pr-3 text-gray-400 tabular-nums">{op.id}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-gray-600">{day(op.date)}</td>
                    <td className="py-2 pr-3 text-green-700">{op.in_bi_code || op.in_bi_name}</td>
                    <td className="py-2 pr-3 text-red-600">{op.out_bi_code || op.out_bi_name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-gray-800 whitespace-nowrap">{money(op.amount)}</td>
                    <td className="py-2 text-gray-500 [overflow-wrap:anywhere]">{op.content}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {ops?.length ? `Операций: ${ops.length}` : ''}
          </span>
          <button onClick={onClose}
            className="px-4 py-2 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}
