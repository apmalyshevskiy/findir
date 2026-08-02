import { useEffect, useRef, useState } from 'react'
import { getAiStatus, parseOperation, transcribeAudio } from '../api/ai'
import AiNewItems from './AiNewItems'
import AiLinks from './AiLinks'

const money = (v) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(v || 0)

// Диалог переживает переход между разделами и перезагрузку вкладки.
// Ключ привязан к тенанту, чтобы чужой диалог не всплыл после смены компании.
const storeKey = () => {
  let tenant = ''
  try { tenant = JSON.parse(localStorage.getItem('tenant') || '{}').id || '' } catch { /* ignore */ }
  return `ai_dialog_${tenant}`
}
const loadSaved = () => {
  try { return JSON.parse(sessionStorage.getItem(storeKey()) || '{}') } catch { return {} }
}

/**
 * Диалоговый ввод операции: текст или голос, с уточнениями.
 * Операцию не создаёт — готовит черновик, который пользователь
 * подтверждает в обычной форме (onUseDraft).
 */
export default function AiQuickEntry({ onUseDraft, onSaveTemplate, resetKey = 0 }) {
  const [enabled, setEnabled] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')          // '' | 'parse' | 'stt' | 'save'
  const [error, setError] = useState('')
  const [turns, setTurns] = useState(() => loadSaved().turns || [])        // лента: {role:'user'|'ai', ...}
  const [history, setHistory] = useState(() => loadSaved().history || [])  // контекст для модели
  const [recording, setRecording] = useState(false)
  const recRef = useRef(null)
  const chunksRef = useRef([])
  const endRef = useRef(null)

  useEffect(() => {
    getAiStatus().then(r => setEnabled(!!r.data.enabled)).catch(() => setEnabled(false))
  }, [])

  useEffect(() => { if (resetKey) reset() }, [resetKey])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [turns])

  // Сохраняем диалог, чтобы он не терялся при уходе на другую вкладку
  useEffect(() => {
    try {
      if (turns.length === 0 && history.length === 0) sessionStorage.removeItem(storeKey())
      else sessionStorage.setItem(storeKey(), JSON.stringify({ turns, history }))
    } catch { /* приватный режим / переполнение — не критично */ }
  }, [turns, history])

  const reset = () => { setTurns([]); setHistory([]); setText(''); setError('') }

  if (!enabled) return null

  const send = async (value) => {
    const t = (value ?? text).trim()
    if (!t || busy) return
    setBusy('parse'); setError('')
    setTurns(prev => [...prev, { role: 'user', text: t }])
    setText('')
    try {
      const r = await parseOperation(t, undefined, history)
      const drafts = r.data.drafts || []
      const newItems = r.data.new_items || []
      const links = r.data.links || []
      const reply = r.data.reply || ''
      setTurns(prev => [...prev, { role: 'ai', reply, drafts, newItems, links }])
      setHistory(prev => [...prev, { role: 'user', content: t }, { role: 'assistant', content: r.data.assistant || '' }])
      if (!reply && drafts.length === 0 && newItems.length === 0 && links.length === 0) {
        setError('Не удалось распознать — опишите подробнее.')
      }
    } catch (e) {
      setError(e?.response?.data?.message || 'Ошибка разбора')
    } finally { setBusy('') }
  }

  // Элемент(ы) созданы: убираем из списка предложений, остальные остаются доступны.
  // Диалог НЕ трогаем — иначе панель перестанет быть последней и список пропадёт.
  const markCreated = (turnIdx, made) => {
    setTurns(prev => prev.map((t, i) => {
      if (i !== turnIdx) return t
      const isMade = (x) => made.some(m => m.type === x.type && m.name === x.name)
      return {
        ...t,
        newItems: (t.newItems || []).filter(x => !isMade(x)),
        createdItems: [...(t.createdItems || []), ...made],
      }
    }))
  }

  // Связи проставлены — убираем их из предложений, диалог не трогаем
  const markLinked = (turnIdx, done) => {
    setTurns(prev => prev.map((t, i) => {
      if (i !== turnIdx) return t
      const isDone = (x) => done.some(d => d.flow_id === x.flow_id)
      return {
        ...t,
        links: (t.links || []).filter(x => !isDone(x)),
        appliedLinks: [...(t.appliedLinks || []), ...done],
      }
    }))
  }

  // Работа со списком завершена — сообщаем модели, чтобы подставила элементы в черновик
  const finishItems = async (made) => {
    if (!made?.length) return
    const names = made.map(c => `«${c.name}»`).join(', ')
    await send(`Создано в справочнике: ${names} — используй их.`)
  }

  const startRec = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setBusy('stt')
        try {
          const r = await transcribeAudio(new Blob(chunksRef.current, { type: 'audio/webm' }))
          const t = (r.data.text || '').trim()
          setBusy('')
          if (t) await send(t)
          else setError('Речь не распознана — попробуйте ещё раз.')
        } catch (e) {
          setError(e?.response?.data?.message || 'Ошибка распознавания речи')
          setBusy('')
        }
      }
      rec.start(); recRef.current = rec; setRecording(true)
    } catch { setError('Нет доступа к микрофону') }
  }

  const stopRec = () => { recRef.current?.stop(); setRecording(false) }

  const busyLabel = busy === 'stt' ? 'Распознаю речь…' : busy === 'parse' ? 'Думаю…' : busy === 'save' ? 'Создаю…' : ''
  const lastIdx = turns.length - 1

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500 flex items-center gap-1.5">
          <svg className="w-4 h-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/></svg>
          Быстрый ввод — можно уточнять сообщениями
        </span>
        {turns.length > 0 && (
          <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-700">Начать заново</button>
        )}
      </div>

      {/* Лента диалога */}
      {turns.length > 0 && (
        <div className="max-h-[420px] overflow-y-auto space-y-2 mb-3 pr-1">
          {turns.map((t, i) => {
            if (t.role === 'user') {
              return (
                <div key={i} className="flex justify-end">
                  <div className="bg-blue-900 text-white text-sm rounded-2xl rounded-br-sm px-3 py-1.5 max-w-[80%]">{t.text}</div>
                </div>
              )
            }
            if (t.created) {
              return <p key={i} className="text-xs text-green-700">✓ Создано: {t.created.label} «{t.created.name}»</p>
            }
            const isLast = i === lastIdx
            return (
              <div key={i} className="space-y-2">
                {t.reply && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 text-gray-800 text-sm rounded-2xl rounded-bl-sm px-3 py-2 max-w-[85%] whitespace-pre-wrap">{t.reply}</div>
                  </div>
                )}
                {(t.drafts || []).map((d, k) => {
                  const p = d.payload || {}
                  const low = (d.confidence ?? 0) < 0.7
                  return (
                    <div key={k} className={`rounded-lg border p-3 ${low ? 'border-amber-200 bg-amber-50/50' : 'border-green-200 bg-green-50/40'} ${!isLast ? 'opacity-60' : ''}`}>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-sm text-gray-800">
                          <span className="font-semibold">{money(p.amount)}</span>
                          <span className="text-gray-500"> · {p.date}</span>
                          {p.content && <span className="text-gray-600"> · {p.content}</span>}
                        </div>
                        {isLast && (
                          <div className="flex items-center gap-1.5">
                            {onSaveTemplate && (
                              <button onClick={() => onSaveTemplate(p, p.content)} title="Сохранить как шаблон для повтора"
                                className="px-2 py-1.5 border border-gray-200 bg-white rounded-lg text-xs text-gray-500 hover:text-amber-600 hover:border-amber-300">
                                ★ В шаблоны
                              </button>
                            )}
                            <button onClick={() => onUseDraft(p)}
                              className="px-3 py-1.5 bg-blue-900 text-white rounded-lg text-xs font-medium hover:bg-blue-800">
                              Открыть в форме →
                            </button>
                          </div>
                        )}
                      </div>
                      {d.question && <p className="text-xs text-amber-700 mt-1.5">⚠ {d.question}</p>}
                      {(d.warnings || []).map((w, x) => <p key={x} className="text-xs text-amber-700 mt-1">⚠ {w}</p>)}
                      <p className="text-[10px] text-gray-400 mt-1.5">
                        Уверенность: {Math.round((d.confidence ?? 0) * 100)}% · можно уточнить сообщением ниже
                      </p>
                    </div>
                  )
                })}

                {isLast && (t.newItems || []).length > 0 && (
                  <AiNewItems
                    items={t.newItems}
                    created={t.createdItems || []}
                    disabled={!!busy}
                    onCreated={(made) => markCreated(i, made)}
                    onAllDone={finishItems}
                  />
                )}
                {isLast && (t.links || []).length > 0 && (
                  <AiLinks
                    links={t.links}
                    applied={t.appliedLinks || []}
                    disabled={!!busy}
                    onApplied={(done) => markLinked(i, done)}
                  />
                )}
                {isLast && (t.links || []).length === 0 && (t.appliedLinks || []).length > 0 && (
                  <p className="text-xs text-green-700">✓ Проставлено связей: {t.appliedLinks.length}</p>
                )}
                {isLast && (t.newItems || []).length === 0 && (t.createdItems || []).length > 0 && (
                  <p className="text-xs text-green-700">
                    ✓ Создано в справочниках ({t.createdItems.length}): {t.createdItems.map(c => c.name).join(', ')}
                  </p>
                )}
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      )}

      {/* Ввод */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="flex-1 min-w-[240px] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={turns.length ? 'Уточните: «статья — Аренда помещения», «сумма 65000»…' : 'Опишите операцию: «оплатил аренду 50000 с расчётного счёта»'}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}
          disabled={!!busy}
        />
        <button type="button" onClick={recording ? stopRec : startRec} disabled={!!busy}
          title={recording ? 'Остановить запись' : 'Записать голосом'}
          className={`w-9 h-9 flex-shrink-0 rounded-lg flex items-center justify-center border transition-colors ${
            recording ? 'bg-red-600 border-red-600 text-white animate-pulse' : 'border-gray-200 text-gray-500 hover:text-blue-600 hover:border-blue-300'
          } disabled:opacity-40`}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3" />
          </svg>
        </button>
        <button type="button" onClick={() => send()} disabled={!!busy || !text.trim()}
          className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-40">
          {busyLabel || 'Отправить'}
        </button>
      </div>

      {recording && <p className="text-xs text-red-600 mt-2">● Идёт запись — нажмите на микрофон, чтобы остановить</p>}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}
