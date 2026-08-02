import { useEffect, useState } from 'react'
import { getTemplates, useTemplate, deleteTemplate } from '../api/operationTemplates'

const money = (v) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0)
const todayIso = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Шаблоны регулярных операций: клик — и черновик открывается в форме
 * с текущей датой. Частые шаблоны идут первыми.
 */
export default function OperationTemplates({ onUse, refreshKey = 0 }) {
  const [items, setItems] = useState([])

  const load = () => getTemplates().then(r => setItems(r.data.data || [])).catch(() => setItems([]))
  useEffect(() => { load() }, [refreshKey])

  if (items.length === 0) return null

  const apply = (t) => {
    useTemplate(t.id).catch(() => {})
    onUse({ ...t.payload, date: todayIso() })
    setItems(list => list.map(x => x.id === t.id ? { ...x, use_count: x.use_count + 1 } : x))
  }

  const remove = async (t, e) => {
    e.stopPropagation()
    if (!confirm(`Удалить шаблон «${t.name}»?`)) return
    await deleteTemplate(t.id)
    load()
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-3 mb-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-500 flex items-center gap-1.5 mr-1">
          <svg className="w-4 h-4 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1L12 2z"/></svg>
          Повторить
        </span>
        {items.map(t => (
          <button key={t.id} onClick={() => apply(t)} title={`Применить шаблон (использован ${t.use_count} раз)`}
            className="group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full border border-gray-200 text-sm text-gray-700 hover:border-amber-300 hover:bg-amber-50 transition-colors">
            <span>{t.name}</span>
            {t.payload?.amount ? <span className="text-xs text-gray-400 tabular-nums">{money(t.payload.amount)}</span> : null}
            <span onClick={(e) => remove(t, e)} title="Удалить шаблон"
              className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-500 px-1">×</span>
          </button>
        ))}
      </div>
    </div>
  )
}
