import { useEffect, useState } from 'react'
import { getAccountCatalog, addAccountsFromCatalog } from '../api/balanceItems'
import { SkeletonRows } from './Busy'
import { INFO_LABELS } from '../utils/infoLabels'

/**
 * Добавление счетов из каталога.
 *
 * Новый тенант получает только заводские счета — те, без которых учёт не
 * начать. Всё остальное заводится здесь, когда понадобится: «Деньги в пути»
 * нужны кафе с эквайрингом, «Кредиты банков» — тому, кто их брал, и навязывать
 * их всем незачем.
 *
 * Уже заведённые показываем серым, а не прячем: так виден весь план целиком и
 * понятно, что ничего не потеряно.
 */
export default function ChartOfAccountsPicker({ onClose, onAdded }) {
  const [groups, setGroups]   = useState({})
  const [items, setItems]     = useState(null)
  const [picked, setPicked]   = useState(new Set())
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  useEffect(() => {
    getAccountCatalog()
      .then(r => { setGroups(r.data.groups || {}); setItems(r.data.data || []) })
      .catch(e => setError(e.response?.data?.message || 'Не удалось загрузить список счетов'))
  }, [])

  // Esc закрывает: окно модальное, тянуться мышью к крестику не хочется
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (code) => setPicked(p => {
    const next = new Set(p)
    next.has(code) ? next.delete(code) : next.add(code)
    return next
  })

  const add = async () => {
    if (picked.size === 0) return
    setSaving(true); setError('')
    try {
      const r = await addAccountsFromCatalog([...picked])
      onAdded(r.data.created || [])
    } catch (e) {
      setError(e.response?.data?.message || 'Не удалось добавить счета')
      setSaving(false)
    }
  }

  const analytics = (a) => [a.info_1_type, a.info_2_type]
    .filter(Boolean).map(t => INFO_LABELS[t] || t).join(' · ')

  const available = (items || []).filter(a => !a.exists).length

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8" onClick={e => e.stopPropagation()}>

        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Добавить счета из списка</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Стандартные счета учёта. Заводите те, что нужны — остальные не будут мешать в оборотке
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
          {items === null ? (
            <SkeletonRows rows={6} />
          ) : available === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">
              Все счета из списка уже заведены
            </p>
          ) : (
            Object.entries(groups).map(([key, label]) => {
              const group = items.filter(a => a.group === key)
              if (group.length === 0) return null
              return (
                <div key={key} className="mb-5 last:mb-0">
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</div>
                  <div className="space-y-1">
                    {group.map(a => (
                      <label key={a.code}
                        className={`flex items-start gap-3 px-3 py-2 rounded-lg border transition-colors ${
                          a.exists
                            ? 'border-gray-100 bg-gray-50 cursor-default'
                            : picked.has(a.code)
                              ? 'border-blue-300 bg-blue-50/60 cursor-pointer'
                              : 'border-gray-100 hover:border-blue-200 cursor-pointer'
                        }`}>
                        <input type="checkbox" className="rounded mt-0.5"
                          checked={a.exists || picked.has(a.code)}
                          disabled={a.exists || saving}
                          onChange={() => toggle(a.code)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2 flex-wrap">
                            <span className={`font-mono text-xs ${a.exists ? 'text-gray-400' : 'text-gray-600'}`}>{a.code}</span>
                            <span className={`text-sm ${a.exists ? 'text-gray-400' : 'text-gray-800'}`}>{a.name}</span>
                            {a.exists && <span className="text-[11px] text-gray-400">уже есть</span>}
                            {a.is_default && !a.exists && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 ring-1 ring-blue-200">
                                базовый
                              </span>
                            )}
                          </span>
                          {a.hint && (
                            <span className={`block text-[11px] mt-0.5 ${a.exists ? 'text-gray-300' : 'text-gray-500'}`}>
                              {a.hint}
                            </span>
                          )}
                          {(analytics(a) || a.has_quantity) && (
                            <span className="block text-[11px] text-gray-400 mt-0.5">
                              Аналитика: {analytics(a) || '—'}
                              {a.has_quantity && ' · количественный учёт'}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {error && <div className="mx-6 mb-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-100">
          <span className="text-xs text-gray-400">
            Подчинённый счёт приходит вместе со своей группой
          </span>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">
              Отмена
            </button>
            <button onClick={add} disabled={saving || picked.size === 0}
              className="px-4 py-2 text-sm text-white bg-blue-900 hover:bg-blue-800 rounded-lg disabled:opacity-40">
              {saving ? 'Добавляю…' : `Добавить${picked.size ? ` (${picked.size})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
