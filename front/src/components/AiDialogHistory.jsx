import { useEffect, useRef, useState } from 'react'
import { listDialogs, removeDialog } from '../api/aiDialogs'

/**
 * Прошлые диалоги с помощником.
 *
 * Раньше диалог был ровно один: «Начать заново» стирало предыдущий вместе с
 * неразобранными черновиками. Теперь он уходит сюда, и к нему можно вернуться —
 * счёт на пять позиций редко вносят за один присест.
 *
 * Список свой у каждого: сервер отдаёт только диалоги того, кто спрашивает.
 */

/**
 * Время из базы — UTC: часовой пояс приложения UTC, и `now()` пишет его как
 * есть. Разбираем как UTC и показываем в поясе браузера, иначе «сегодня 14:32»
 * разъезжается с часами на экране.
 */
export const parseUtc = (s) => {
  const t = String(s || '').replace(' ', 'T')
  return new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`)
}

const fmtWhen = (iso) => {
  const d = parseUtc(iso)
  if (isNaN(d)) return ''

  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

  return sameDay ? `сегодня ${time}` : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`
}

const fmtCost = (cost) => cost == null || cost <= 0
  ? ''
  : `${Number(cost).toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} ₽`

export default function AiDialogHistory({ currentId, onPick, refreshKey = 0 }) {
  const [open, setOpen]       = useState(false)
  const [items, setItems]     = useState(null)   // null — ещё не грузили
  const [error, setError]     = useState('')
  const boxRef = useRef(null)

  const load = () => {
    listDialogs()
      .then(r => { setItems(r.data.data || []); setError('') })
      .catch(() => setError('Не удалось загрузить историю'))
  }

  // Обновляем при открытии и когда диалог сохранился: заголовок и счётчик
  // записанных в списке должны совпадать с тем, что на экране
  useEffect(() => { if (open) load() }, [open, refreshKey])

  useEffect(() => {
    if (!open) return

    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const drop = async (e, d) => {
    e.stopPropagation()
    if (!confirm(`Удалить диалог «${d.title}»? Записанные операции останутся.`)) return

    try {
      await removeDialog(d.id)
      setItems(prev => (prev || []).filter(x => x.id !== d.id))
    } catch {
      setError('Не удалось удалить')
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="text-xs text-gray-400 hover:text-gray-700">
        История
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-30 w-96 max-w-[90vw] bg-white border border-gray-200 rounded-lg shadow-xl max-h-96 overflow-y-auto">
          {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}

          {items === null && !error && (
            <p className="px-3 py-2 text-xs text-gray-400">Загружаю…</p>
          )}

          {items?.length === 0 && (
            <p className="px-3 py-3 text-xs text-gray-400">
              Прошлых диалогов нет. Сюда попадают все — в том числе те, что закрыли кнопкой «Начать заново».
            </p>
          )}

          {(items || []).map(d => (
            <div key={d.id}
              onClick={() => { if (d.id !== currentId) { onPick(d.id); setOpen(false) } }}
              className={`px-3 py-2 border-b border-gray-100 last:border-0 flex items-start gap-2 ${
                d.id === currentId ? 'bg-blue-50/60' : 'hover:bg-gray-50 cursor-pointer'
              }`}>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-800 truncate" title={d.title}>{d.title}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  {fmtWhen(d.updated_at)}
                  {d.drafts_total > 0 && <> · записано {d.drafts_saved} из {d.drafts_total}</>}
                  {fmtCost(d.cost) && <> · {fmtCost(d.cost)}</>}
                  {d.id === currentId && <> · открыт</>}
                </div>
              </div>
              <button type="button" onClick={(e) => drop(e, d)} title="Удалить диалог"
                className="text-gray-300 hover:text-red-500 text-xs shrink-0 mt-0.5">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
