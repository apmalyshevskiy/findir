import { useEffect, useState } from 'react'
import { getDocument } from '../api/documents'

/**
 * Просмотр документа поверх текущей страницы.
 *
 * Со страницы загрузки уводить некуда: человек посреди разбора списка, и
 * переход в справочник документов заставил бы возвращаться и заново запрашивать
 * период. Поэтому смотрим здесь же, а правка — по ссылке в соседней вкладке.
 */

const money = (v) => Number(v ?? 0).toLocaleString('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})

const fmtDateTime = (s) => {
  if (!s) return '—'
  const d = new Date(String(s).replace(' ', 'T'))
  return isNaN(d) ? s : d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const STATUS = {
  draft:     { label: 'черновик', cls: 'bg-gray-100 text-gray-600 ring-gray-200' },
  posted:    { label: 'проведён', cls: 'bg-green-50 text-green-700 ring-green-200' },
  cancelled: { label: 'отменён',  cls: 'bg-red-50 text-red-700 ring-red-200' },
}

const TYPE = {
  incoming_invoice: 'Приходная накладная',
  outgoing_invoice: 'Расходная накладная',
}

export default function DocumentPeek({ id, onClose }) {
  const [doc, setDoc]     = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    getDocument(id)
      .then(r => { if (alive) setDoc(r.data.data) })
      .catch(() => { if (alive) setError('Документ не найден — возможно, его удалили') })
    return () => { alive = false }
  }, [id])

  // Esc закрывает: окно модальное, и мышь для выхода искать не хочется
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const st = STATUS[doc?.status] || STATUS.draft

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mt-10 mb-10"
           onClick={e => e.stopPropagation()}>

        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-100">
          <div>
            <div className="font-semibold text-gray-800">
              {TYPE[doc?.type] || 'Документ'} {doc?.number ? `№${doc.number}` : ''}
            </div>
            {doc && (
              <div className="text-xs text-gray-400 mt-0.5">
                от {fmtDateTime(doc.date)}
                {doc.external_number && <> · номер поставщика {doc.external_number}</>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {doc && (
              <span className={`px-2 py-0.5 rounded text-[11px] font-medium ring-1 ${st.cls}`}>{st.label}</span>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
          </div>
        </div>

        <div className="px-6 py-4">
          {error && <div className="text-sm text-red-600">{error}</div>}
          {!doc && !error && <div className="text-sm text-gray-400">Загружаю...</div>}

          {doc && (
            <>
              <dl className="text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-4">
                <dt className="text-gray-400">Счёт шапки</dt>
                <dd className="text-gray-800">{doc.bi_code} {doc.bi_name}</dd>

                {doc.info_1_name && <>
                  <dt className="text-gray-400">Контрагент</dt>
                  <dd className="text-gray-800">{doc.info_1_name}</dd>
                </>}

                <dt className="text-gray-400">Содержание</dt>
                <dd className="text-gray-700">{doc.content || '—'}</dd>

                {doc.note && <>
                  <dt className="text-gray-400">Комментарий</dt>
                  <dd className="text-gray-600">{doc.note}</dd>
                </>}
              </dl>

              {doc.items?.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400 text-left">
                        <th className="py-1.5 pr-3 font-medium">Счёт</th>
                        <th className="py-1.5 pr-3 font-medium">Номенклатура</th>
                        <th className="py-1.5 pr-3 font-medium text-right">Кол-во</th>
                        <th className="py-1.5 pr-3 font-medium text-right">Цена</th>
                        <th className="py-1.5 font-medium text-right">Сумма</th>
                      </tr>
                    </thead>
                    <tbody>
                      {doc.items.map(it => (
                        <tr key={it.id} className="border-t border-gray-100">
                          <td className="py-1.5 pr-3 text-gray-700 whitespace-nowrap">{it.bi_code} {it.bi_name}</td>
                          <td className="py-1.5 pr-3 text-gray-700">{it.info_1_name || '—'}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-gray-600">{it.quantity}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-gray-600">{money(it.price)}</td>
                          <td className="py-1.5 text-right tabular-nums text-gray-800">{money(it.amount)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-gray-200 font-medium">
                        <td className="py-1.5 pr-3 text-gray-700" colSpan={4}>Итого</td>
                        <td className="py-1.5 text-right tabular-nums text-gray-900">{money(doc.amount)} ₽</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-gray-100">
          {/* Правка — в соседней вкладке: разобранный список остаётся на месте */}
          <a href={`/documents?open=${id}`} target="_blank" rel="noopener noreferrer"
             className="text-xs text-blue-700 hover:underline">
            Открыть для правки в новой вкладке →
          </a>
          <button onClick={onClose}
            className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}
