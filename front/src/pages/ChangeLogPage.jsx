import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import api from '../api/client'
import { BusyLabel, SkeletonRows } from '../components/Busy'
import { openObject } from '../components/ObjectOpener'
import { localDate } from '../utils/period'
import { dayBound, whenUtc } from '../utils/datetime'

/**
 * Журнал изменений: что вообще происходило в базе.
 *
 * История внутри объекта отвечает «что стало с этой операцией». Здесь другой
 * вопрос — кто работал вчера, что принесла загрузка 1С, куда делись суммы
 * после массовой правки.
 *
 * Пачка — одно действие человека: загрузка правит десятки объектов разом.
 * Поэтому у строки видно, сколько ещё правок пришло вместе с ней, и по ней
 * можно отобрать всю пачку целиком.
 */

const ENTITY_TONE = {
  operation: 'bg-blue-50 text-blue-700 ring-blue-200',
  document:  'bg-violet-50 text-violet-700 ring-violet-200',
  info:      'bg-emerald-50 text-emerald-700 ring-emerald-200',
}

const ACTION_TONE = {
  created:  'text-green-700',
  updated:  'text-blue-700',
  deleted:  'text-red-600',
  restored: 'text-violet-700',
}

const ENTITY_OPTIONS = [
  { value: '',          label: 'Все объекты' },
  { value: 'operation', label: 'Операции' },
  { value: 'document',  label: 'Документы' },
  { value: 'info',      label: 'Справочники' },
]

const sel = 'px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

export default function ChangeLogPage() {
  const [rows, setRows]       = useState(null)
  const [meta, setMeta]       = useState({})
  const [filters, setFilters] = useState({ users: [], sources: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  // Месяц назад — разумное начало: журнал ведут не для археологии, а чтобы
  // разобраться в том, что случилось на днях
  const monthAgo = () => { const d = new Date(); d.setMonth(d.getMonth() - 1); return localDate(d) }

  const [q, setQ] = useState({
    entity: '', source: '', user_id: '', batch: '',
    date_from: monthAgo(), date_to: localDate(new Date()),
  })

  const load = (page = 1, append = false) => {
    setLoading(true); setError('')

    const params = { page, ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '')) }

    // Границы дня шлём с поясом: в базе время в UTC, и без сдвига ночная
    // правка выпадала бы из своего же дня
    if (params.date_from) params.date_from = dayBound(params.date_from)
    if (params.date_to)   params.date_to   = dayBound(params.date_to, true)

    api.get('/change-log', { params })
      .then(r => {
        setRows(prev => append ? [...(prev || []), ...r.data.data] : r.data.data)
        setMeta(r.data.meta || {})
        setFilters(r.data.filters || { users: [], sources: [] })
      })
      .catch(e => setError(e.response?.data?.message || 'Не удалось прочитать журнал'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(1) }, [q])

  const set = (patch) => setQ(prev => ({ ...prev, ...patch }))

  /**
   * Объект открывается поверх журнала.
   *
   * Уводить на страницу списка было неверно: человек смотрел журнал, а
   * оказывался в операциях за какой-то период, и возвращаться приходилось
   * кнопкой «назад»
   */
  const open = (r) => openObject(r.entity, r.entity_id)

  const isDirty = q.entity || q.source || q.user_id || q.batch

  return (
    <Layout>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">Журнал изменений</h2>
          <p className="text-xs text-gray-500 mt-1">
            Кто и что менял в операциях, документах и справочниках. Ведётся с 14 сентября 2026 года
          </p>
        </div>
        <BusyLabel active={loading}>Читаю журнал</BusyLabel>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4 flex items-center gap-2 flex-wrap">
        <input type="date" value={q.date_from} onChange={e => set({ date_from: e.target.value })} className={sel} />
        <span className="text-gray-300">—</span>
        <input type="date" value={q.date_to} onChange={e => set({ date_to: e.target.value })} className={sel} />

        <select value={q.entity} onChange={e => set({ entity: e.target.value })} className={sel}>
          {ENTITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select value={q.user_id} onChange={e => set({ user_id: e.target.value })} className={sel}>
          <option value="">Все люди</option>
          {filters.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>

        <select value={q.source} onChange={e => set({ source: e.target.value })} className={sel}>
          <option value="">Любой источник</option>
          {filters.sources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        {q.batch && (
          <button onClick={() => set({ batch: '' })}
            className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-900 ring-1 ring-amber-200 text-xs">
            одна пачка ×
          </button>
        )}

        {isDirty && (
          <button onClick={() => set({ entity: '', source: '', user_id: '', batch: '' })}
            className="text-xs text-gray-400 hover:text-red-600">↺ сбросить</button>
        )}

        <span className="text-xs text-gray-400 ml-auto">
          {meta.total != null && `правок: ${meta.total}`}
        </span>
      </div>

      {error && <div className="mb-4 bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm">{error}</div>}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-clip">
        {!rows ? (
          <div className="p-4"><SkeletonRows rows={8} height="h-10" /></div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-gray-400 text-sm">За выбранный период правок нет</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium whitespace-nowrap">Когда</th>
                <th className="px-3 py-2 text-left font-medium">Кто</th>
                <th className="px-3 py-2 text-left font-medium">Объект</th>
                <th className="px-3 py-2 text-left font-medium">Что изменилось</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.entity}-${r.entity_id}-${r.version}`} className="border-t border-gray-100 align-top hover:bg-blue-50/30">
                  <td className="px-4 py-2 whitespace-nowrap text-gray-600 text-xs">
                    {whenUtc(r.created_at)}
                    <div className={`${ACTION_TONE[r.action] || ''} font-medium`}>{r.action_label}</div>
                  </td>

                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    <div className="text-gray-700">{r.user_name || 'система'}</div>
                    {r.source !== 'manual' && <div className="text-gray-400">{r.source_label}</div>}
                    {/* Пачка — одно действие человека; по ней отбираем всё,
                        что приехало вместе */}
                    {r.batch_size > 1 && (
                      <button onClick={() => set({ batch: r.batch })}
                        className="text-[11px] text-blue-600 hover:underline">
                        ещё {r.batch_size - 1} в пачке
                      </button>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    <button onClick={() => open(r)} className="text-left group">
                      <span className={`px-1.5 py-0.5 rounded ring-1 text-[11px] font-medium ${ENTITY_TONE[r.entity]}`}>
                        {r.entity_label}
                      </span>
                      <div className="text-xs text-gray-700 group-hover:text-blue-700 group-hover:underline mt-0.5 max-w-xs truncate"
                        title={r.title}>
                        {r.title}
                      </div>
                    </button>
                  </td>

                  <td className="px-3 py-2">
                    {r.changes.length === 0
                      ? <span className="text-gray-300 text-xs">—</span>
                      : <table className="text-[11px]">
                          <tbody>
                            {r.changes.map((c, i) => (
                              <tr key={i} className="align-top">
                                <td className="pr-2 py-0.5 text-gray-500 whitespace-nowrap">{c.label}</td>
                                <td className="pr-1.5 py-0.5 text-gray-400 line-through max-w-[14rem] truncate" title={c.was}>{c.was}</td>
                                <td className="pr-1.5 py-0.5 text-gray-300">→</td>
                                <td className="py-0.5 text-gray-800 max-w-[14rem] truncate" title={c.now}>{c.now}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {meta.has_more && (
        <div className="mt-3 text-center">
          <button onClick={() => load((meta.page || 1) + 1, true)} disabled={loading}
            className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50">
            {loading ? 'Загружаю…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </Layout>
  )
}
