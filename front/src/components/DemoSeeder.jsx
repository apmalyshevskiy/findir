import { useEffect, useRef, useState } from 'react'
import { getDemoDatasets, seedDemo } from '../api/demo'
import { Spinner } from './Busy'

/**
 * Заполнение чистой компании демо-данными — для показа.
 *
 * Пункта в меню нет намеренно. Это инструмент продавца, а не бухгалтера: он
 * нужен раз в жизни компании, в первые пять минут, и в ряду ежедневных
 * разделов только мешал бы. Поэтому вызов скрытый — наберите `demo` на любой
 * странице, не стоя в поле ввода.
 *
 * Сочетание с Ctrl или Alt было бы проще, но все удобные заняты браузером:
 * Ctrl+Shift+D складывает вкладки в закладки, Alt+D уводит в адресную строку.
 * Набор слова ничем не конфликтует и забывается ровно настолько, насколько
 * нужно тайной кнопке.
 */

/** Сколько ждём между буквами, прежде чем считать набор начатым заново */
const GAP_MS = 1500
const WORD = 'demo'

export default function DemoSeeder() {
  const [open, setOpen]       = useState(false)
  const [state, setState]     = useState(null)   // ответ /demo/datasets
  const [picked, setPicked]   = useState('')
  const [busy, setBusy]       = useState(false)
  const [done, setDone]       = useState(null)
  const [error, setError]     = useState('')
  const typed = useRef({ at: 0, text: '' })

  // ── Тайный вызов ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return

      // В поле ввода слово «demo» — это текст, а не команда
      const t = e.target
      const tag = (t?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return

      const now = Date.now()
      const prev = now - typed.current.at > GAP_MS ? '' : typed.current.text
      const next = (prev + (e.key || '').toLowerCase()).slice(-WORD.length)

      typed.current = { at: now, text: next }

      if (next === WORD) {
        typed.current = { at: 0, text: '' }
        setOpen(true)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return

    setError('')
    getDemoDatasets()
      .then(res => {
        setState(res.data)
        const first = (res.data.data || []).find(d => d.ready)
        if (first) setPicked(first.key)
      })
      .catch(err => setError(err.response?.data?.message || 'Раздел закрыт правами вашей должности'))
  }, [open])

  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape' && !busy) close() }
    if (open) window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open, busy])

  const close = () => {
    setOpen(false); setState(null); setDone(null); setError(''); setPicked('')
  }

  const run = async () => {
    setBusy(true); setError('')
    try {
      const res = await seedDemo(picked)
      setDone(res.data)
    } catch (err) {
      setError(err.response?.data?.message || 'Не удалось заполнить базу')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const sets = state?.data || []

  return (
    <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-4"
      onMouseDown={() => !busy && close()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[88vh] flex flex-col"
        onMouseDown={e => e.stopPropagation()}>

        <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-gray-800">Демо-данные</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Наполнить компанию данными для показа
            </p>
          </div>
          {!busy && (
            <button onClick={close} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
          )}
        </div>

        <div className="overflow-y-auto p-5">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
          )}

          {done ? (
            <div className="text-center py-6">
              <div className="text-3xl mb-3">✓</div>
              <p className="text-gray-800 font-medium">Компания наполнена: {done.name}</p>
              <p className="text-sm text-gray-500 mt-2">
                операций {done.counts?.operations ?? 0}, документов {done.counts?.documents ?? 0},
                бюджетов {done.counts?.budget_documents ?? 0} — за {done.seconds} с
              </p>
              <button onClick={() => window.location.assign('/dashboard')}
                className="mt-6 px-5 py-2.5 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
                Открыть дашборд
              </button>
            </div>
          ) : busy ? (
            <div className="text-center py-10">
              <div className="flex items-center justify-center gap-3 text-gray-600">
                <Spinner /> Заполняю базу…
              </div>
              <p className="text-xs text-gray-400 mt-3">
                Это займёт около минуты. Не закрывайте вкладку: генератор заводит
                тысячи операций и проводит каждый документ так же, как это делает
                программа.
              </p>
            </div>
          ) : (
            <>
              {state && !state.can_seed && (
                <div className="bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 rounded-lg text-sm mb-4">
                  {state.reason}
                </div>
              )}

              {!state && !error && (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-6 justify-center">
                  <Spinner /> Читаю состояние базы…
                </div>
              )}

              <div className="space-y-2">
                {sets.map(s => (
                  <label key={s.key}
                    className={`block border rounded-xl p-3 transition-colors ${
                      !s.ready ? 'border-gray-100 bg-gray-50/60 cursor-default'
                        : picked === s.key ? 'border-blue-300 bg-blue-50/50 cursor-pointer'
                        : 'border-gray-200 hover:border-blue-200 cursor-pointer'
                    }`}>
                    <div className="flex items-start gap-2.5">
                      <input type="radio" name="demo-dataset" className="mt-1 w-4 h-4 text-blue-600"
                        disabled={!s.ready || !state?.can_seed}
                        checked={picked === s.key}
                        onChange={() => setPicked(s.key)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${s.ready ? 'text-gray-800' : 'text-gray-400'}`}>
                            {s.name}
                          </span>
                          {!s.ready && (
                            <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
                              скоро
                            </span>
                          )}
                        </div>
                        <p className={`text-xs mt-0.5 ${s.ready ? 'text-gray-500' : 'text-gray-400'}`}>
                          {s.description}
                        </p>
                        {s.about?.length > 0 && picked === s.key && (
                          <ul className="mt-2 space-y-0.5">
                            {s.about.map((line, i) => (
                              <li key={i} className="text-xs text-gray-500 flex gap-1.5">
                                <span className="text-gray-300">·</span>{line}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {!done && !busy && (
          <div className="p-5 border-t border-gray-100 flex gap-3">
            <button onClick={close}
              className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
              Отмена
            </button>
            <button onClick={run} disabled={!picked || !state?.can_seed}
              className="flex-1 px-4 py-2.5 bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50 text-sm font-medium">
              Заполнить
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
