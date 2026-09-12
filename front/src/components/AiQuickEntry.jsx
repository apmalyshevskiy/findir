import { useEffect, useRef, useState } from 'react'
import { getAiStatus, parseOperation, parseFile, transcribeAudio, applyBulk, revertBulk } from '../api/ai'
import { createDialog, saveDialog, getDialog, listDialogs } from '../api/aiDialogs'
import AiNewItems from './AiNewItems'
import AiLinks from './AiLinks'
import AiDialogHistory, { parseUtc } from './AiDialogHistory'
import ReportChart from './ReportChart'
import useElapsed from '../hooks/useElapsed'

const money = (v) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(v || 0)

/**
 * Ожидание ответа ИИ.
 *
 * Пузырь на месте будущего ответа с бегущими точками — так ждут в любом чате,
 * и видно, что вопрос принят. Секундомер появляется через три секунды: модель
 * думает от пяти до тридцати, и без счётчика начинает казаться, что зависло.
 *
 * Верхнюю полоску загрузки для этого не используем — она у края окна, далеко
 * от того места, куда смотрит человек.
 */
function ThinkingBubble({ label }) {
  const { seconds } = useElapsed(true, 0)

  return (
    <div className="flex justify-start">
      <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2.5 flex items-center gap-2">
        <span className="flex gap-1">
          {[0, 150, 300].map(delay => (
            <span key={delay}
              className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
              style={{ animationDelay: `${delay}ms` }} />
          ))}
        </span>
        <span className="text-xs text-gray-500">{label}</span>
        {seconds >= 3 && (
          <span className="text-[11px] text-gray-400 tabular-nums">
            {seconds.toFixed(0)} с
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Цена одного обращения к ИИ.
 *
 * Копейки, поэтому знаков после запятой больше обычного: округление до копейки
 * превратило бы почти каждый ответ в ноль. Наценку применил сервер — здесь
 * только показ.
 */
const chargeLabel = (charge) => {
  const cost = Number(charge.cost || 0)
  const sum = cost.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
  const unit = charge.currency === 'RUB' ? '₽' : (charge.currency || '')
  const tokens = Number(charge.total_tokens || 0).toLocaleString('ru-RU')
  return `${sum} ${unit} · ${tokens} токенов`
}

/**
 * Диалог хранится в базе компании (см. AiDialogsController), а в браузере —
 * быстрый кэш: он поднимает ленту мгновенно при перезагрузке и держит её, когда
 * сервер не ответил. Источник правды — база; кэш только опережает её.
 *
 * Ключ привязан к тенанту, чтобы чужой диалог не всплыл после смены компании.
 */
const storeKey = () => {
  let tenant = ''
  try { tenant = JSON.parse(localStorage.getItem('tenant') || '{}').id || '' } catch { /* ignore */ }
  return `ai_dialog_${tenant}`
}

// Дольше половины суток не храним: диалог, всплывший через неделю, — не помощь.
// В нём черновики с позавчерашней датой, и записать такой по привычке легко
const MAX_AGE = 12 * 3600 * 1000

const loadSaved = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey()) || '{}')
    return saved.savedAt && Date.now() - saved.savedAt < MAX_AGE ? saved : {}
  } catch { return {} }
}

const SIDE_LABEL = { debit: 'приход (дебет)', credit: 'расход (кредит)', net: 'сальдо' }

const fmtDate = (iso) => {
  const p = String(iso || '').split('-')
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso
}

/**
 * Карточка показателя. Все цифры пришли с сервера — модель их не считала
 * и не могла придумать: она описала только выборку.
 */
function ReportCard({ report }) {
  const rows = report.rows || []
  // Вид по умолчанию выбирает сервер: без графика показываем таблицу
  const [view, setView] = useState(report.chart ? 'chart' : 'table')

  // Отбор не разрешился — цифру не показываем: сумма по всему счёту под
  // заголовком «расходы на эквайринг» ввела бы в заблуждение
  if (report.error) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
        <div className="text-sm font-semibold text-gray-800">{report.title}</div>
        <div className="text-xs text-amber-700 mt-1">⚠ {report.error}</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-sm font-semibold text-gray-800">{report.title}</div>
        <div className="flex items-center gap-2">
          {report.chart && rows.length > 0 && (
            <div className="flex rounded-md border border-blue-200 overflow-hidden text-[10px]">
              {[{ k: 'chart', t: '▦ График' }, { k: 'table', t: '☰ Таблица' }].map(v => (
                <button key={v.k} type="button" onClick={() => setView(v.k)}
                  className={`px-1.5 py-0.5 transition-colors ${
                    view === v.k ? 'bg-blue-900 text-white' : 'text-blue-700 hover:bg-blue-100'
                  }`}>
                  {v.t}
                </button>
              ))}
            </div>
          )}
          <div className="text-lg font-bold text-blue-900">{money(report.total)}</div>
        </div>
      </div>

      <div className="text-[11px] text-gray-500 mt-0.5">
        {fmtDate(report.date_from)} — {fmtDate(report.date_to)}
        {report.account && <> · счёт {report.account.code} {report.account.name}</>}
        {' · '}{SIDE_LABEL[report.side] || report.side}
        {report.operations > 0 && <> · операций: {report.operations}</>}
      </div>

      {/* Отбор виден явно: по цифре должно быть понятно, что именно посчитано */}
      {report.filter && (
        <div className="mt-1">
          <span className="inline-block text-[11px] bg-blue-100 text-blue-800 rounded px-1.5 py-0.5">
            только «{report.filter.name}»
          </span>
        </div>
      )}

      {rows.length > 0 && (
        view === 'chart' && report.chart
          ? <ReportChart type={report.chart} rows={rows} />
          : (
            <table className="w-full mt-2 text-xs">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-blue-100/70">
                    <td className="py-1 pr-2 text-gray-700">{r.name}</td>
                    <td className="py-1 text-right text-gray-500 w-16">{r.operations}</td>
                    <td className="py-1 pl-2 text-right font-medium text-gray-800 whitespace-nowrap">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {report.total === 0 && rows.length === 0 && (
        <div className="text-xs text-gray-400 mt-1.5">За период движений нет</div>
      )}
    </div>
  )
}

/**
 * Диалоговый ввод операции: текст или голос, с уточнениями.
 * Операцию не создаёт — готовит черновик, который пользователь
 * подтверждает в обычной форме (onUseDraft).
 */
export default function AiQuickEntry({ onUseDraft, onSaveTemplate, onChanged }) {
  const [enabled, setEnabled] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')          // '' | 'parse' | 'stt' | 'save'
  const [error, setError] = useState('')
  const [turns, setTurns] = useState(() => loadSaved().turns || [])        // лента: {role:'user'|'ai', ...}
  const [history, setHistory] = useState(() => loadSaved().history || [])  // контекст для модели
  const [dialogId, setDialogId] = useState(() => loadSaved().dialogId || null)
  const [sync, setSync] = useState('')          // '' | 'saving' | 'saved' | 'error'
  const [historyKey, setHistoryKey] = useState(0)
  const [recording, setRecording] = useState(false)
  const recRef = useRef(null)
  const chunksRef = useRef([])
  const endRef = useRef(null)
  const fileRef = useRef(null)
  const inputRef = useRef(null)

  // Номер диалога нужен обработчику сохранения, который живёт в таймере: к
  // моменту срабатывания состояние из его замыкания уже устарело
  const dialogIdRef = useRef(dialogId)
  // Первая отрисовка и восстановление ленты записью не считаются: иначе диалог
  // сохранялся бы сам собой при каждом открытии страницы
  const skipSave = useRef(true)
  const savingRef = useRef(false)
  const pendingRef = useRef(false)

  // Поле растёт под текст само, до ~7 строк, дальше — прокрутка внутри.
  // Высоту меряем через scrollHeight: сбросили в auto, взяли фактическую
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 168) + 'px'
  }, [text])

  useEffect(() => {
    getAiStatus().then(r => setEnabled(!!r.data.enabled)).catch(() => setEnabled(false))
  }, [])

  // Прокручиваем и на начало ожидания: пузырь «думаю» должен быть виден,
  // иначе он появится ниже края ленты и человек его не заметит
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [turns, busy])

  // Кэш в браузере: чтобы лента вернулась мгновенно, не дожидаясь сервера
  useEffect(() => {
    try {
      if (turns.length === 0 && history.length === 0) localStorage.removeItem(storeKey())
      else localStorage.setItem(storeKey(), JSON.stringify({ turns, history, dialogId, savedAt: Date.now() }))
      sessionStorage.removeItem(storeKey())   // диалог переехал в localStorage
    } catch { /* приватный режим / переполнение — не критично */ }
  }, [turns, history, dialogId])

  /**
   * Запись диалога в базу.
   *
   * Пока запись идёт, новые изменения не плодят второй запрос — они ставятся в
   * очередь одним флагом. Иначе первый же ответ модели, меняющий состояние
   * дважды, создал бы два диалога вместо одного.
   */
  const flush = async (t, h) => {
    if (savingRef.current) { pendingRef.current = true; return }

    savingRef.current = true
    setSync('saving')
    try {
      if (dialogIdRef.current) {
        await saveDialog(dialogIdRef.current, t, h)
      } else {
        const r = await createDialog(t, h)
        dialogIdRef.current = r.data.data.id
        setDialogId(r.data.data.id)
      }
      setSync('saved')
      setHistoryKey(k => k + 1)
    } catch {
      // Не роняем чат: лента цела, в кэше браузера она тоже есть
      setSync('error')
    } finally {
      savingRef.current = false
      if (pendingRef.current) { pendingRef.current = false; flush(t, h) }
    }
  }

  // Задержка гасит дребезг: за один ответ модели состояние меняется несколько раз
  useEffect(() => {
    if (skipSave.current) { skipSave.current = false; return }
    if (turns.length === 0 && history.length === 0) return

    const id = setTimeout(() => flush(turns, history), 1500)
    return () => clearTimeout(id)
  }, [turns, history])

  /**
   * Восстановление на чистом устройстве.
   *
   * Кэша нет — берём самый свежий диалог с сервера, если он моложе полусуток.
   * Правило то же, что у кэша: диалог недельной давности подставлять нельзя,
   * в нём черновики с позавчерашними датами. Такой остаётся в «Истории».
   */
  useEffect(() => {
    // Ждём ответа про доступность ИИ: без прав на помощника ходить за его
    // диалогами незачем — там нечему быть
    if (!enabled || turns.length > 0 || history.length > 0) return

    let alive = true
    listDialogs()
      .then(r => {
        const last = (r.data.data || [])[0]
        if (!alive || !last || Date.now() - parseUtc(last.updated_at).getTime() > MAX_AGE) return
        return getDialog(last.id)
      })
      .then(d => {
        if (!alive || !d) return
        const row = d.data.data
        skipSave.current = true
        dialogIdRef.current = row.id
        setDialogId(row.id)
        setTurns(row.turns || [])
        setHistory(row.history || [])
      })
      .catch(() => { /* нет связи — работаем с пустой лентой */ })

    return () => { alive = false }
  }, [enabled])

  // «Начать заново» больше ничего не уничтожает: диалог остаётся в базе и
  // виден в «Истории», а на экране начинается новый
  const reset = () => {
    skipSave.current = true
    dialogIdRef.current = null
    setDialogId(null)
    setTurns([]); setHistory([]); setText(''); setError(''); setSync('')
    setHistoryKey(k => k + 1)
  }

  // Открыть прошлый диалог из истории
  const openDialog = async (id) => {
    setError('')
    try {
      const r = await getDialog(id)
      skipSave.current = true
      dialogIdRef.current = id
      setDialogId(id)
      setTurns(r.data.data.turns || [])
      setHistory(r.data.data.history || [])
      setSync('saved')
    } catch {
      setError('Не удалось открыть диалог')
    }
  }

  // Сколько стоил весь диалог: складываем цену ответов текущей ленты
  const dialogCost = turns.reduce((acc, t) => t.charge?.cost == null ? acc : {
    cost:         acc.cost + Number(t.charge.cost),
    total_tokens: acc.total_tokens + Number(t.charge.total_tokens || 0),
    currency:     t.charge.currency || acc.currency,
  }, { cost: 0, total_tokens: 0, currency: 'RUB' })

  if (!enabled) return null

  const send = async (value) => {
    const t = (value ?? text).trim()
    if (!t || busy) return
    setBusy('parse'); setError('')
    setTurns(prev => [...prev, { role: 'user', text: t }])
    setText('')
    try {
      applyResult(await parseOperation(t, undefined, history), t)
    } catch (e) {
      setError(e?.response?.data?.message || 'Ошибка разбора')
    } finally { setBusy('') }
  }

  // Общая обработка ответа модели (для текста и для файлов)
  const applyResult = (r, userContent) => {
    const drafts = r.data.drafts || []
    const newItems = r.data.new_items || []
    const links = r.data.links || []
    const bulk = r.data.bulk || []
    const reports = r.data.reports || []
    const reply = r.data.reply || ''
    setTurns(prev => [...prev, { role: 'ai', reply, drafts, newItems, links, bulk, reports, charge: r.data.charge }])
    setHistory(prev => [...prev, { role: 'user', content: userContent }, { role: 'assistant', content: r.data.assistant || '' }])
    if (!reply && drafts.length === 0 && newItems.length === 0 && links.length === 0 && bulk.length === 0 && reports.length === 0) {
      setError('Не удалось распознать — опишите подробнее.')
    }
  }

  // Массовая правка существующих операций — применяется только по кнопке
  const runBulk = async (turnIdx, b) => {
    if (!confirm(`Изменить ${b.count} ${b.count === 1 ? 'операцию' : 'операций'}? Действие затронет уже проведённые данные.`)) return
    setBusy('save'); setError('')
    try {
      const r = await applyBulk(b.filter, b.set)
      setTurns(prev => prev.map((t, i) => i !== turnIdx ? t : {
        ...t,
        bulk: (t.bulk || []).filter(x => x !== b),
        bulkDone: [...(t.bulkDone || []), {
          updated: r.data.updated, skipped: r.data.skipped,
          lock: r.data.lock_applied, logId: r.data.log_id, reverted: false,
        }],
      }))
      if (onChanged) onChanged()
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось применить правку')
    } finally { setBusy('') }
  }

  // Откат массовой правки по журналу
  const undoBulk = async (turnIdx, k, logId) => {
    if (!confirm('Вернуть прежние значения по этой правке?')) return
    setBusy('save'); setError('')
    try {
      const r = await revertBulk(logId)
      setTurns(prev => prev.map((t, i) => i !== turnIdx ? t : {
        ...t,
        bulkDone: (t.bulkDone || []).map((d, j) => j === k
          ? { ...d, reverted: true, restored: r.data.restored, revSkipped: r.data.skipped } : d),
      }))
      if (onChanged) onChanged()
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось откатить правку')
    } finally { setBusy('') }
  }

  // Прикреплённый файл: фото чека, счёт, выписка xlsx/csv
  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || busy) return
    const note = text.trim()
    setBusy('file'); setError('')
    setTurns(prev => [...prev, { role: 'user', text: note ? `📎 ${file.name} — ${note}` : `📎 ${file.name}` }])
    setText('')
    try {
      applyResult(await parseFile(file, note, history), note ? `${note} [файл ${file.name}]` : `[файл ${file.name}]`)
    } catch (err) {
      setError(err?.response?.data?.message || 'Не удалось разобрать файл')
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

  /**
   * Открыть черновик в форме операции.
   *
   * Вторым аргументом отдаём отметку «записано»: страница вызовет её после
   * сохранения и передаст номер созданной операции. Раньше страница вместо
   * этого сбрасывала весь диалог — а в одном ответе черновиков бывает несколько
   * (счёт на пять позиций, выписка), и вместе с диалогом уносило все
   * незаписанные.
   */
  const openDraft = (turnIdx, k, payload) => {
    onUseDraft(payload, (operationId) => setTurns(prev => prev.map((t, i) => i !== turnIdx ? t : {
      ...t,
      drafts: (t.drafts || []).map((d, j) => j === k ? { ...d, saved: true, operationId } : d),
    })))
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

  const busyLabel = busy === 'stt' ? 'Распознаю речь…' : busy === 'parse' ? 'Думаю…'
    : busy === 'file' ? 'Читаю файл…' : busy === 'save' ? 'Создаю…' : ''
  const lastIdx = turns.length - 1

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500 flex items-center gap-1.5">
          <svg className="w-4 h-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/></svg>
          Быстрый ввод — можно уточнять сообщениями
        </span>
        <div className="flex items-center gap-3">
          {/* Молча терять диалог нельзя: если запись не прошла, человек должен
              это видеть — лента пока держится только кэшем браузера */}
          {sync === 'error' && (
            <span className="text-[11px] text-amber-700" title="Диалог остался в этом браузере, но на сервер не записан">
              не сохранён
            </span>
          )}
          {sync === 'saved' && dialogId && (
            <span className="text-[11px] text-gray-300">сохранён</span>
          )}
          <AiDialogHistory currentId={dialogId} onPick={openDialog} refreshKey={historyKey} />
          {turns.length > 0 && (
            <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-700">Начать заново</button>
          )}
        </div>
      </div>

      {/* Лента диалога. Показываем и когда она пуста, но ИИ уже думает:
          первый вопрос иначе уходил бы в тишину */}
      {(turns.length > 0 || busy) && (
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
                {/* Во что обошёлся ответ. Мелким и серым: цифра нужна для
                    контроля расхода, а не для чтения диалога */}
                {t.charge?.cost != null && (
                  <div className="text-[10px] text-gray-400 pl-1">
                    {chargeLabel(t.charge)}
                  </div>
                )}
                {/* Показатели: цифры посчитал сервер по базе, не модель */}
                {(t.reports || []).map((rep, k) => <ReportCard key={`r${k}`} report={rep} />)}

                {/* Сколько операций в ответе и сколько уже записано. Их вносят
                    по очереди, и без счётчика в длинном ответе легко потерять,
                    на чём остановился */}
                {isLast && (t.drafts || []).length > 1 && (
                  <p className="text-[11px] text-gray-500 pl-1">
                    Операций в ответе: {t.drafts.length} · записано {t.drafts.filter(d => d.saved).length} —
                    открывайте по очереди, диалог сохранится
                  </p>
                )}

                {(t.drafts || []).map((d, k) => {
                  const p = d.payload || {}
                  const low = (d.confidence ?? 0) < 0.7
                  return (
                    <div key={k} className={`rounded-lg border p-3 ${
                      d.saved ? 'border-green-300 bg-green-50/70'
                        : low ? 'border-amber-200 bg-amber-50/50' : 'border-green-200 bg-green-50/40'
                    } ${!isLast && !d.saved ? 'opacity-60' : ''}`}>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-sm text-gray-800">
                          <span className="font-semibold">{money(p.amount)}</span>
                          <span className="text-gray-500"> · {p.date}</span>
                          {p.content && <span className="text-gray-600"> · {p.content}</span>}
                        </div>
                        {/* Записанный черновик кнопки не показывает: второй раз
                            открывать его незачем, а по невнимательности так
                            заводится дубль проводки */}
                        {d.saved ? (
                          <span className="text-xs font-medium text-green-700 whitespace-nowrap">
                            ✓ Записана{d.operationId ? ` · операция #${d.operationId}` : ''}
                          </span>
                        ) : isLast && (
                          <div className="flex items-center gap-1.5">
                            {onSaveTemplate && (
                              <button onClick={() => onSaveTemplate(p, p.content)} title="Сохранить как шаблон для повтора"
                                className="px-2 py-1.5 border border-gray-200 bg-white rounded-lg text-xs text-gray-500 hover:text-amber-600 hover:border-amber-300">
                                ★ В шаблоны
                              </button>
                            )}
                            <button onClick={() => openDraft(i, k, p)}
                              className="px-3 py-1.5 bg-blue-900 text-white rounded-lg text-xs font-medium hover:bg-blue-800">
                              Открыть в форме →
                            </button>
                          </div>
                        )}
                      </div>
                      {!d.saved && (
                        <>
                          {d.question && <p className="text-xs text-amber-700 mt-1.5">⚠ {d.question}</p>}
                          {(d.warnings || []).map((w, x) => <p key={x} className="text-xs text-amber-700 mt-1">⚠ {w}</p>)}
                          <p className="text-[10px] text-gray-400 mt-1.5">
                            Уверенность: {Math.round((d.confidence ?? 0) * 100)}%
                            {isLast ? ' · можно уточнить сообщением ниже' : ' · черновик из прошлого ответа, смотрите ниже'}
                          </p>
                        </>
                      )}
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
                {/* Правка, которую не собрать: показываем причину. Молчаливый
                    пропуск оставлял человека с обещанием кнопки, которой нет */}
                {isLast && (t.bulk || []).filter(b => b.problem).map((b, k) => (
                  <div key={`bp${k}`} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <p className="text-xs font-medium text-gray-700 mb-1">Массовую правку применить нельзя</p>
                    <p className="text-sm text-gray-800">{b.problem}</p>
                    {b.hint && <p className="text-xs text-blue-700 mt-1">{b.hint}</p>}
                    {(b.filter?.account_code || b.filter?.date_from || b.filter?.content_like) && (
                      <p className="text-[11px] text-gray-500 mt-1.5">
                        Условие было:
                        {b.filter.account_code && <> счёт {b.filter.account_code}</>}
                        {b.filter.date_from && <> · с {b.filter.date_from}</>}
                        {b.filter.date_to && <> по {b.filter.date_to}</>}
                        {b.filter.content_like && <> · содержание содержит «{b.filter.content_like}»</>}
                      </p>
                    )}
                  </div>
                ))}

                {isLast && (t.bulk || []).filter(b => !b.problem).map((b, k) => (
                  <div key={`b${k}`} className="rounded-lg border border-amber-300 bg-amber-50/60 p-3">
                    <p className="text-xs font-medium text-amber-900 mb-1">
                      Массовая правка уже проведённых операций
                    </p>
                    <p className="text-sm text-gray-800">
                      Затронет <b>{b.count}</b> {b.count === 1 ? 'операцию' : 'операций'}
                      {b.filter?.date_from && <> · период {b.filter.date_from} — {b.filter.date_to || '…'}</>}
                      {b.filter?.account_code && <> · счёт {b.filter.account_code}
                        {b.filter.side !== 'any' && <> ({b.filter.side === 'debit' ? 'дебет' : 'кредит'})</>}</>}
                    </p>
                    <p className="text-sm text-gray-700 mt-0.5">
                      Проставить: {Object.entries(b.set).map(([t2, v]) => `${t2} → «${v.name}»`).join(', ')}
                    </p>
                    {(b.sample || []).length > 0 && (
                      <p className="text-[11px] text-gray-500 mt-1">
                        например: {b.sample.map(s => `#${s.id} ${s.date}`).join(', ')}…
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <button onClick={() => runBulk(i, b)} disabled={!!busy}
                        className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-medium hover:bg-amber-700 disabled:opacity-40">
                        {busy === 'save' ? 'Применяю…' : `Применить к ${b.count}`}
                      </button>
                      <span className="text-[11px] text-gray-500">действие необратимо — проверьте условие</span>
                    </div>
                  </div>
                ))}
                {isLast && (t.bulkDone || []).map((d, k) => (
                  <div key={`bd${k}`} className="flex items-center justify-between gap-3 flex-wrap">
                    {d.reverted ? (
                      <p className="text-xs text-gray-500">
                        ↩ Правка откачена: восстановлено {d.restored}
                        {d.revSkipped > 0 && <> · пропущено {d.revSkipped}</>}
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-green-700">
                          ✓ Изменено операций: {d.updated}
                          {d.skipped > 0 && <> · пропущено {d.skipped} (нет подходящего разреза)</>}
                          {d.lock && <> · ограничено датой запрета {d.lock}</>}
                        </p>
                        {d.logId && (
                          <button onClick={() => undoBulk(i, k, d.logId)} disabled={!!busy}
                            className="px-2.5 py-1 border border-gray-200 bg-white rounded-lg text-xs text-gray-600 hover:text-amber-700 hover:border-amber-300 disabled:opacity-40">
                            ↩ Откатить
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
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
          {busy && <ThinkingBubble label={busyLabel} />}
          <div ref={endRef} />
        </div>
      )}

      {/* Ввод. Кнопки прижаты к низу: когда поле разрастается на несколько
          строк, им место рядом с последней, как в любом чате */}
      <div className="flex items-end gap-2 flex-wrap">
        <textarea
          ref={inputRef}
          rows={1}
          className="flex-1 min-w-[240px] px-3 py-2 border border-gray-200 rounded-lg text-sm leading-relaxed
                     resize-none overflow-y-auto focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={turns.length ? 'Уточните: «статья — Аренда помещения», «сумма 65000»…' : 'Опишите операцию: «оплатил аренду 50000 с расчётного счёта»'}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            // Enter отправляет, Shift+Enter переносит строку — как в чатах.
            // isComposing — чтобы Enter при наборе через IME не улетал письмом
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          disabled={!!busy}
        />
        <input ref={fileRef} type="file" className="hidden" onChange={onFile}
          accept="image/*,.pdf,.csv,.txt,.xml,.xlsx,.xls,.ods" />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy}
          title="Прикрепить фото чека, PDF-счёт или выписку (xlsx, csv, xml)"
          className="w-9 h-9 flex-shrink-0 rounded-lg flex items-center justify-center border border-gray-200 text-gray-500 hover:text-blue-600 hover:border-blue-300 transition-colors disabled:opacity-40">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" />
          </svg>
        </button>
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

      {/* Подсказка про перенос строки — иначе о Shift+Enter не догадаться.
          Рядом — сколько стоил весь диалог: расход виден, не отходя от чата */}
      <p className="text-[11px] text-gray-400 mt-1.5">
        Enter — отправить · Shift+Enter — новая строка
        {dialogCost.cost > 0 && (
          <> · за диалог: {chargeLabel({ ...dialogCost, currency: dialogCost.currency })}</>
        )}
      </p>

      {recording && <p className="text-xs text-red-600 mt-2">● Идёт запись — нажмите на микрофон, чтобы остановить</p>}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}
