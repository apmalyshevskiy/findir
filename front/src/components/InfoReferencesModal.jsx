import { useEffect, useState } from 'react'
import { getInfoReferences } from '../api/info'
import { openObject } from './ObjectOpener'
import { SkeletonRows } from './Busy'

/**
 * Где используется элемент справочника.
 *
 * Вопрос возникает в двух случаях. Первый — элемент мешает: его хотят удалить
 * или перенести в другой справочник, а система отказывает, и надо увидеть, кто
 * держит. Второй — элемент просто завели давно: «Прочие расходы» живут год, и
 * никто уже не помнит, что в них попадает.
 *
 * Поэтому число и список здесь вместе: счёт отвечает «сколько», строки — «чем
 * именно», а клик уводит в сам объект. Подписи строк собирает сервер: он знает,
 * что в документе показывать номер, а в бюджете — название и месяц.
 *
 * Открытый объект закрывает список: форма операции и эта таблица живут на одном
 * уровне, и показывать их друг поверх друга значило бы спорить за z-index.
 */
export default function InfoReferencesModal({ id, name, onClose }) {
  const [data, setData]       = useState(null)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(true)

  // `loading` уже true с первого рендера — ставить его здесь незачем: окно
  // открывается на один элемент и живёт до закрытия
  useEffect(() => {
    let alive = true

    getInfoReferences(id)
      .then(res => { if (alive) { setData(res.data); setError('') } })
      .catch(err => { if (alive) setError(err.response?.data?.message || 'Не удалось посчитать ссылки') })
      .finally(() => { if (alive) setLoading(false) })

    return () => { alive = false }
  }, [id])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const open = (row) => {
    if (!row.entity || !row.entity_id) return
    onClose()
    openObject(row.entity, row.entity_id)
  }

  const groups = data?.groups || []

  return (
    <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4"
      onMouseDown={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onMouseDown={e => e.stopPropagation()}>

        <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-gray-800">Где используется</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {name || data?.name}
              {data ? ` · ссылок: ${data.total}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto p-5">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
          {loading && <SkeletonRows rows={5} />}

          {data && data.total === 0 && (
            <div className="text-center py-10">
              <p className="text-sm text-gray-500">На элемент никто не ссылается</p>
              <p className="text-xs text-gray-400 mt-1.5 max-w-md mx-auto">
                Его можно удалить или перенести в другой справочник — ничего из
                записанного это не затронет.
              </p>
            </div>
          )}

          {groups.map(g => (
            <div key={g.table} className="mb-5 last:mb-0">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-sm font-semibold text-gray-700 first-letter:uppercase">{g.label}</span>
                <span className="text-xs text-gray-400 tabular-nums">{g.count}</span>
                {/* Закрытые должностью счета: ссылка есть, а смотреть её нельзя.
                    Молчать об этом нельзя — список выглядел бы неполным зря */}
                {g.restricted && (
                  <span className="text-xs text-amber-700" title="Часть ссылок на закрытых для вас счетах">
                    видно {g.visible}
                  </span>
                )}
              </div>

              <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 overflow-hidden">
                {g.rows.map((r, i) => (
                  <div key={i}
                    onClick={() => open(r)}
                    className={`px-3 py-2 ${r.entity ? 'cursor-pointer hover:bg-blue-50/60' : ''}`}
                    title={r.entity ? 'Открыть' : ''}>
                    <div className="text-sm text-gray-800 flex items-center gap-2">
                      <span className="[overflow-wrap:anywhere]">{r.title}</span>
                      {r.entity && <span className="text-xs text-blue-500">↗</span>}
                    </div>
                    {r.subtitle && (
                      <div className="text-xs text-gray-400 [overflow-wrap:anywhere]">{r.subtitle}</div>
                    )}
                  </div>
                ))}

                {g.rows.length === 0 && (
                  <div className="px-3 py-2 text-xs text-gray-400">
                    Все ссылки — на закрытых для вас счетах
                  </div>
                )}
              </div>

              {g.visible > g.rows.length && g.rows.length > 0 && (
                <p className="text-xs text-gray-400 mt-1.5">
                  Показаны первые {g.rows.length} из {g.visible}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {data?.total > 0 ? 'Клик по строке открывает объект' : ''}
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
