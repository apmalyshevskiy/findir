import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'

const HIDDEN_KEY = 'findir:first-steps-hidden'

/**
 * Карточка «Первые шаги» на дашборде.
 *
 * Не тур со стрелками поверх интерфейса: такой тур ломается от любой правки
 * вёрстки, а поддерживать его на двадцати семи страницах невозможно. Здесь —
 * список того, без чего система не заработает, и каждый пункт отмечен по
 * фактическому состоянию базы, а не по нажатию «понятно».
 *
 * Карточка исчезает сама, когда все шаги пройдены: онбординг, который остаётся
 * на экране навсегда, превращается в мебель. Свернуть раньше времени можно, это
 * личное решение — оно и живёт в браузере, а не в общей настройке компании.
 */
export default function FirstSteps() {
  const navigate = useNavigate()

  const [state, setState]   = useState(null)
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(HIDDEN_KEY) === '1' } catch { return false }
  })

  useEffect(() => {
    api.get('/onboarding')
      .then(r => setState(r.data.data))
      .catch(() => { /* нет прав или сеть — дашборд обойдётся без карточки */ })
  }, [])

  if (!state || hidden) return null
  if (state.done >= state.total) return null

  const hide = () => {
    try { localStorage.setItem(HIDDEN_KEY, '1') } catch { /* приватный режим */ }
    setHidden(true)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-4">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Первые шаги</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Галочки ставятся сами, когда шаг сделан. Карточка исчезнет, когда пройдёте все
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-gray-400 tabular-nums">{state.done} из {state.total}</span>
          <button onClick={hide} title="Свернуть — вернуть можно, очистив данные сайта"
            className="text-gray-300 hover:text-gray-500 text-lg leading-none">&times;</button>
        </div>
      </div>

      {/* Полоска вместо процента: важно не точное число, а что дело движется */}
      <div className="h-1 bg-gray-100 rounded-full overflow-hidden my-3">
        <div className="h-full bg-blue-600 rounded-full transition-all duration-500"
          style={{ width: `${Math.round(state.done / state.total * 100)}%` }} />
      </div>

      <div className="space-y-1">
        {state.steps.map(s => (
          <div key={s.key}
            className={`flex items-start gap-3 rounded-lg px-2 py-1.5 ${s.done ? '' : 'hover:bg-blue-50/50'}`}>
            <span className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
              s.done ? 'bg-green-600 text-white' : 'border border-gray-300 text-transparent'
            }`}>✓</span>

            <div className="min-w-0 flex-1">
              <div className={`text-[13px] ${s.done ? 'text-gray-400 line-through' : 'text-gray-800 font-medium'}`}>
                {s.title}
              </div>
              {!s.done && <div className="text-[12px] text-gray-500">{s.hint}</div>}
            </div>

            {!s.done && (
              <button onClick={() => navigate(s.link)}
                className="text-[12px] text-blue-700 hover:underline shrink-0 mt-0.5">
                Открыть →
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-100 text-[12px] text-gray-500">
        Когда операции появятся — <button onClick={() => navigate('/balance-sheet')}
          className="text-blue-700 hover:underline">откройте оборотку</button> и сверьте
        остатки по кассам с настоящими. Сошлись — учёт пошёл.
      </div>
    </div>
  )
}
