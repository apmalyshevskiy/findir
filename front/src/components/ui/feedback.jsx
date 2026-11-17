import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import Modal, { LAYER } from './Modal'
import Button from './Button'
import { Input } from './Field'

/**
 * Уведомления и вопросы — вместо alert(), confirm() и prompt() браузера.
 *
 * Системные окна выглядят чужими, останавливают всю вкладку и не умеют ничего,
 * кроме текста: ни сказать, что действие опасное, ни предложить его отменить.
 * Через prompt() в приложении вводили даже новый пароль — открытым текстом.
 *
 * Вызываются из любого места без хуков и провайдеров:
 *
 *   toast.success('Операция сохранена')
 *   toast.error(apiError(err))
 *   toast('Строка удалена', { action: { label: 'Отменить', onClick: restore } })
 *
 *   if (await confirm({ title: 'Удалить документ?', danger: true })) …
 *   const name = await promptText({ title: 'Название шаблона' })
 *
 * Сами окна рисует <FeedbackHost/>, он стоит один раз в App.
 */

// ── Хранилище: модуль, а не контекст, чтобы звать можно было и из api-слоя ──
let toasts = []
let dialog = null
const listeners = new Set()
const emit = () => listeners.forEach(l => l())
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }

let seq = 0
function push(message, opts = {}) {
  const id = ++seq
  // Ошибка висит дольше: её надо успеть прочитать, а часто и переписать
  const duration = opts.duration ?? (opts.kind === 'error' ? 8000 : opts.action ? 7000 : 4000)
  toasts = [...toasts.slice(-3), { id, message, kind: 'info', ...opts, duration }]
  emit()
  return id
}
function dismiss(id) {
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

// eslint-disable-next-line react-refresh/only-export-components
export const toast = Object.assign(
  (message, opts) => push(message, opts),
  {
    success: (message, opts) => push(message, { ...opts, kind: 'success' }),
    error:   (message, opts) => push(message, { ...opts, kind: 'error' }),
    warning: (message, opts) => push(message, { ...opts, kind: 'warning' }),
    info:    (message, opts) => push(message, { ...opts, kind: 'info' }),
    dismiss,
  },
)

/**
 * Текст ошибки из ответа сервера — тем же порядком, каким его искали по месту
 * на каждой странице: сообщение, первая ошибка проверки, запасной текст.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function apiError(err, fallback = 'Не удалось выполнить действие') {
  const d = err?.response?.data
  if (d?.errors) {
    const first = Object.values(d.errors)[0]
    if (first) return Array.isArray(first) ? first[0] : String(first)
  }
  if (d?.message) return d.message
  if (err?.code === 'ERR_NETWORK') return 'Нет связи с сервером. Проверьте интернет и повторите'
  return fallback
}

function ask(kind, opts) {
  return new Promise(resolve => {
    dialog = { kind, ...opts, resolve }
    emit()
  })
}

/** Да/нет. Возвращает true только на явное согласие; Esc и клик мимо — это «нет» */
// eslint-disable-next-line react-refresh/only-export-components
export const confirm = (opts) => ask('confirm', typeof opts === 'string' ? { title: opts } : opts)

/** Спросить строку. Возвращает её или null, если передумали */
// eslint-disable-next-line react-refresh/only-export-components
export const promptText = (opts) => ask('prompt', typeof opts === 'string' ? { title: opts } : opts)

// ── Отрисовка ──────────────────────────────────────────────────────────────
const TONE = {
  success: { icon: CheckCircle2,  cls: 'text-emerald-600' },
  error:   { icon: XCircle,       cls: 'text-red-600' },
  warning: { icon: AlertTriangle, cls: 'text-amber-600' },
  info:    { icon: Info,          cls: 'text-brand-600' },
}

function ToastItem({ t }) {
  const { icon: Icon, cls } = TONE[t.kind] || TONE.info
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    // Навели мышь — читают: не убираем из-под курсора
    if (paused || !t.duration) return
    const timer = setTimeout(() => dismiss(t.id), t.duration)
    return () => clearTimeout(timer)
  }, [paused, t.id, t.duration])

  return (
    <div role={t.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto w-[min(26rem,calc(100vw-2rem))] flex items-start gap-3 pl-4 pr-2 py-3
                 bg-white border border-gray-200 rounded-xl shadow-pop animate-toast-in">
      <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${cls}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm text-gray-800 leading-5 py-0.5 break-words">
        {t.title && <div className="font-medium text-gray-900">{t.title}</div>}
        {t.message}
      </div>
      {t.action && (
        <button type="button"
          onClick={() => { t.action.onClick?.(); dismiss(t.id) }}
          className="shrink-0 px-2 py-1 text-sm font-medium text-brand-700 hover:bg-brand-50 rounded-md">
          {t.action.label}
        </button>
      )}
      <button type="button" aria-label="Скрыть" onClick={() => dismiss(t.id)}
        className="shrink-0 p-1 text-gray-400 hover:text-gray-700 rounded-md">
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  )
}

function Dialog({ d }) {
  const [value, setValue] = useState(d.defaultValue ?? '')
  const done = useRef(false)

  const finish = (result) => {
    if (done.current) return
    done.current = true
    dialog = null
    emit()
    d.resolve(result)
  }

  const isPrompt = d.kind === 'prompt'
  const ok = () => {
    if (isPrompt) {
      if (d.required !== false && !String(value).trim()) return
      finish(String(value))
    } else finish(true)
  }

  return (
    <Modal size="sm" hideClose onClose={() => finish(isPrompt ? null : false)}
      footer={<>
        <Button variant="ghost" onClick={() => finish(isPrompt ? null : false)}>{d.cancelLabel || 'Отмена'}</Button>
        <Button variant={d.danger ? 'danger' : 'primary'} onClick={ok} data-autofocus={isPrompt ? undefined : ''}>
          {d.confirmLabel || (d.danger ? 'Удалить' : isPrompt ? 'Сохранить' : 'Да')}
        </Button>
      </>}>
      <div className="flex gap-4">
        {d.danger && (
          <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900">{d.title}</h2>
          {d.text && <p className="mt-1.5 text-sm text-gray-600 leading-relaxed whitespace-pre-line">{d.text}</p>}
          {isPrompt && (
            <form className="mt-3" onSubmit={e => { e.preventDefault(); ok() }}>
              <Input data-autofocus="" type={d.type || 'text'} value={value} placeholder={d.placeholder}
                autoComplete={d.type === 'password' ? 'new-password' : 'off'}
                onChange={e => setValue(e.target.value)} />
              {d.hint && <p className="mt-1.5 text-xs text-gray-500">{d.hint}</p>}
            </form>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function FeedbackHost() {
  const items = useSyncExternalStore(subscribe, () => toasts)
  const d = useSyncExternalStore(subscribe, () => dialog)

  // Сообщение, оставленное перед перезагрузкой страницы (например, почему
  // закончилась сессия): показываем один раз
  useEffect(() => {
    let text = null
    try {
      text = sessionStorage.getItem('findir:notice')
      sessionStorage.removeItem('findir:notice')
    } catch { /* хранилище недоступно */ }
    if (text) toast.info(text, { duration: 10000 })
  }, [])

  return (
    <>
      {d && <Dialog key={d.title + (d.text || '')} d={d} />}
      {createPortal(
        <div className="fixed bottom-4 right-4 flex flex-col items-end gap-2 pointer-events-none"
          style={{ zIndex: LAYER.toast }}>
          {items.map(t => <ToastItem key={t.id} t={t} />)}
        </div>,
        document.body,
      )}
    </>
  )
}
