import { useState, useRef, useEffect } from 'react'

// Компактный мультиселект статей ДДС.
//   options — [{id, name}], value — массив id, onChange — (ids) => void
export default function FlowMultiSelect({ options = [], value = [], onChange, placeholder = 'Статьи ДДС…' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const set = new Set(value.map(String))
  const toggle = (id) => {
    const s = new Set(value.map(String))
    s.has(String(id)) ? s.delete(String(id)) : s.add(String(id))
    onChange([...s].map(Number))
  }
  const selectedNames = options.filter(o => set.has(String(o.id))).map(o => o.name)

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(v => !v)}
        className="w-full text-left px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white hover:bg-gray-50 truncate">
        {selectedNames.length === 0
          ? <span className="text-gray-400">{placeholder}</span>
          : <span className="text-gray-700">{selectedNames.length <= 2 ? selectedNames.join(', ') : `Выбрано: ${selectedNames.length}`}</span>}
      </button>
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto py-1">
          {options.length === 0 && <div className="px-3 py-2 text-sm text-gray-400">Нет статей ДДС</div>}
          {options.map(o => (
            <label key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-blue-50 cursor-pointer">
              <input type="checkbox" checked={set.has(String(o.id))} onChange={() => toggle(o.id)} />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
