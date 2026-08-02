import { useEffect, useMemo, useState } from 'react'
import { getInfo, createInfo } from '../api/info'

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

/** Плоский список справочника с отступами по иерархии */
const flatten = (items) => {
  const byParent = {}
  items.forEach(i => { const p = i.parent_id ?? 0; (byParent[p] ||= []).push(i) })
  const out = []
  const walk = (pid, depth) => {
    ;(byParent[pid] || []).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(b.name))
      .forEach(i => { out.push({ ...i, depth }); walk(i.id, depth + 1) })
  }
  walk(0, 0)
  return out
}

/**
 * Предложения ИИ создать элементы справочников.
 * Родителя можно поменять перед созданием; «Создать все» соблюдает порядок
 * (сначала родители, потом дочерние).
 */
export default function AiNewItems({ items, disabled, onDone }) {
  const [dicts, setDicts] = useState({})        // type => [элементы справочника]
  const [parents, setParents] = useState({})    // индекс элемента => выбранный parent_id ('' | id | 'new:Имя')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const types = useMemo(() => [...new Set(items.map(i => i.type))], [items])

  useEffect(() => {
    types.forEach(t => {
      if (dicts[t]) return
      getInfo({ type: t }).then(r => setDicts(d => ({ ...d, [t]: r.data.data || [] }))).catch(() => {})
    })
  }, [types])

  // Значение селекта по умолчанию — то, что предложил ИИ
  const parentValue = (idx) => {
    if (parents[idx] !== undefined) return parents[idx]
    const it = items[idx]
    if (it.parent_id) return String(it.parent_id)
    if (it.parent_pending && it.parent_name) return `new:${it.parent_name}`
    return ''
  }

  const createAll = async () => {
    setBusy(true); setError('')
    const created = {}   // `${type}|${norm(name)}` => id
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const v = parentValue(i)
        let parent_id = null
        if (v.startsWith('new:')) parent_id = created[`${it.type}|${norm(v.slice(4))}`] ?? null
        else if (v) parent_id = Number(v)

        const r = await createInfo({ name: it.name, type: it.type, parent_id })
        const id = r?.data?.data?.id
        if (id) created[`${it.type}|${norm(it.name)}`] = id
      }
      onDone(items)
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось создать элементы')
    } finally { setBusy(false) }
  }

  const createOne = async (idx) => {
    setBusy(true); setError('')
    const it = items[idx]
    try {
      const v = parentValue(idx)
      const parent_id = v && !v.startsWith('new:') ? Number(v) : null
      await createInfo({ name: it.name, type: it.type, parent_id })
      onDone([it])
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось создать элемент')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-xs font-medium text-blue-800">
          Добавить в справочники{items.length > 1 ? ` (${items.length})` : ''}:
        </p>
        {items.length > 1 && (
          <button onClick={createAll} disabled={busy || disabled}
            className="px-3 py-1 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-40">
            {busy ? 'Создаю…' : 'Создать все'}
          </button>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto space-y-1">
        {items.map((it, idx) => {
          const opts = flatten(dicts[it.type] || [])
          const pending = items.filter((x, k) => k !== idx && x.type === it.type)
          return (
            <div key={idx} className="flex items-center gap-2 flex-wrap py-0.5">
              <span className="text-sm text-gray-800 min-w-[180px] flex-1">
                <span className="text-gray-500 text-xs">{it.label}:</span> {it.name}
              </span>
              <select
                value={parentValue(idx)}
                onChange={e => setParents(p => ({ ...p, [idx]: e.target.value }))}
                disabled={busy || disabled}
                className="px-2 py-1 border border-gray-200 rounded-lg text-xs bg-white max-w-[220px]"
                title="Родительская группа"
              >
                <option value="">— верхний уровень</option>
                {opts.map(o => (
                  <option key={o.id} value={String(o.id)}>{' '.repeat(o.depth * 2)}{o.depth > 0 ? '└ ' : ''}{o.name}</option>
                ))}
                {pending.map((x, k) => (
                  <option key={`n${k}`} value={`new:${x.name}`}>+ {x.name} (создаётся)</option>
                ))}
              </select>
              <button onClick={() => createOne(idx)} disabled={busy || disabled}
                className="px-2.5 py-1 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-40">
                Создать
              </button>
            </div>
          )
        })}
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}
