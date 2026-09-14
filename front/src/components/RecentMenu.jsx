import { useEffect, useRef, useState } from 'react'
import { readRecent, clearRecent, RECENT_LABEL } from '../utils/recent'
import { openObject } from './ObjectOpener'

/**
 * Недавно открытые — в шапке, одним нажатием.
 *
 * Нужно ровно для двух случаев: случайно закрыл окно и хочешь вернуться;
 * смотрел подряд несколько объектов и надо прыгнуть к предыдущему. Поэтому не
 * страница, а выпадающий список: за списком, ради которого надо куда-то идти,
 * возвращаться дольше, чем найти объект заново.
 */

const TONE = {
  operation: 'bg-blue-50 text-blue-700',
  document:  'bg-violet-50 text-violet-700',
  info:      'bg-emerald-50 text-emerald-700',
}

const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1)  return 'только что'
  if (m < 60) return `${m} мин назад`

  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч назад`

  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}

export default function RecentMenu() {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState(() => readRecent())
  const boxRef = useRef(null)

  // Список пополняется по ходу работы — перечитываем по событию, а не опросом
  useEffect(() => {
    const refresh = () => setList(readRecent())
    window.addEventListener('findir:recent', refresh)
    return () => window.removeEventListener('findir:recent', refresh)
  }, [])

  useEffect(() => {
    if (!open) return

    const onDoc = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Пустой список не показываем вовсе: кнопка, за которой ничего нет, хуже,
  // чем её отсутствие
  if (list.length === 0) return null

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" onClick={() => { setList(readRecent()); setOpen(v => !v) }}
        title="Недавно открытые"
        className={`px-2 py-1 rounded-lg border text-xs font-medium transition-colors ${
          open ? 'bg-blue-900 text-white border-blue-900'
               : 'border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-600'
        }`}>
        Недавние
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-[90] overflow-clip">
          {/* Объект открывается поверх текущей страницы: уходить в его список
              значит терять то, чем человек занят */}
          <div className="max-h-96 overflow-y-auto py-1">
            {list.map(r => (
              <button key={`${r.entity}-${r.id}`}
                onClick={() => { setOpen(false); openObject(r.entity, r.id) }}
                className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-start gap-2">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 mt-0.5 ${TONE[r.entity] || ''}`}>
                  {RECENT_LABEL[r.entity] || r.entity}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-gray-800 truncate" title={r.title}>{r.title}</span>
                  <span className="block text-[10px] text-gray-400">{ago(r.at)}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="px-3 py-2 border-t border-gray-100 flex items-center justify-between">
            <span className="text-[10px] text-gray-400">Список личный, хранится в этом браузере</span>
            <button onClick={() => { clearRecent(); setList([]); setOpen(false) }}
              className="text-[11px] text-gray-400 hover:text-red-600">Очистить</button>
          </div>
        </div>
      )}
    </div>
  )
}
