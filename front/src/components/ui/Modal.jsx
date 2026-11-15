import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { IconButton } from './Button'

/**
 * Слои поверх страницы — в одном месте.
 *
 * Модалки верстались по месту в двух с лишним десятках файлов, и у каждой был
 * свой z-index: от 30 до 10000. Кто кого перекроет, решал случай. Теперь окна
 * складываются в стопку: каждое следующее открытое лежит выше предыдущего, а
 * уведомления — выше всех.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const LAYER = { overlay: 300, toast: 900 }

// Стопка открытых окон: Esc закрывает только верхнее, а не все разом
const stack = []

function useOverlay(open, onClose, { closeOnEsc = true } = {}) {
  const ref = useRef(null)
  // Свежий onClose держим в ref: окно не должно переподписываться на клавиши
  // при каждой перерисовке родителя
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    if (!open) return
    const id = {}
    stack.push(id)

    // Фокус возвращаем туда, откуда окно открыли: иначе после закрытия Tab
    // начинает с начала страницы, и человек теряет место
    const prev = document.activeElement
    const t = setTimeout(() => {
      const el = ref.current
      if (!el || el.contains(document.activeElement)) return
      const auto = el.querySelector('[autofocus], [data-autofocus]')
      ;(auto || el).focus({ preventScroll: true })
    }, 0)

    const onKey = (e) => {
      if (stack[stack.length - 1] !== id) return
      if (e.key === 'Escape' && closeOnEsc) {
        // Раскрытый список или календарь внутри окна закрывается своим Esc —
        // окно при этом остаётся
        if (e.defaultPrevented) return
        e.stopPropagation()
        closeRef.current?.()
      }
      // Tab не выпускаем из окна: под ним страница, которую сейчас трогать нельзя
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )].filter(n => n.offsetParent !== null)
        if (!items.length) return
        const first = items[0], last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)

    // Страница под окном не прокручивается
    const overflow = document.body.style.overflow
    if (stack.length === 1) document.body.style.overflow = 'hidden'

    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      stack.splice(stack.indexOf(id), 1)
      if (stack.length === 0) document.body.style.overflow = overflow
      if (prev instanceof HTMLElement && document.contains(prev)) prev.focus({ preventScroll: true })
    }
  }, [open, closeOnEsc])

  return ref
}

/**
 * Esc для окон, свёрстанных по месту (форма операции, форма документа,
 * расшифровка оборотки): они закрывались только крестиком.
 *
 * В поле ввода первый Esc лишь снимает фокус, окно закрывает второй: внутри
 * форм есть выпадающие списки со своим Esc, и закрыть вместе со списком всю
 * форму с набранными данными — слишком дорогая ошибка.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useEscClose(onClose, enabled = true) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    if (!enabled) return
    const id = {}
    stack.push(id)
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || stack[stack.length - 1] !== id) return
      const t = e.target
      if (t instanceof HTMLElement && (t.matches('input, textarea, select') || t.isContentEditable)) { t.blur(); return }
      closeRef.current?.()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); stack.splice(stack.indexOf(id), 1) }
  }, [enabled])
}

/** Подложка: клик мимо окна закрывает его, но только если нажали и отпустили на самой подложке */
function Backdrop({ onClose, closeOnBackdrop, className, children }) {
  const downOnSelf = useRef(false)
  return (
    <div
      className={cn('fixed inset-0 bg-brand-950/40 animate-fade-in', className)}
      style={{ zIndex: LAYER.overlay }}
      onMouseDown={e => { downOnSelf.current = e.target === e.currentTarget }}
      onMouseUp={e => {
        // Выделяли текст в поле и отпустили мышь за краем окна — это не «клик
        // мимо», и набранное из-за него терять нельзя
        if (closeOnBackdrop && downOnSelf.current && e.target === e.currentTarget) onClose?.()
        downOnSelf.current = false
      }}>
      {children}
    </div>
  )
}

const WIDTH = {
  sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', '2xl': 'max-w-6xl', full: 'max-w-[96vw]',
}

/**
 * Окно поверх страницы.
 *
 * Закрывается крестиком, клавишей Esc и кликом мимо — одинаково везде. Там, где
 * в окне набирают данные, клик мимо отключают (`closeOnBackdrop={false}`):
 * промахнуться мимо поля и потерять полформы хуже, чем лишний раз нажать Esc.
 */
export default function Modal({
  open = true, onClose, title, subtitle, size = 'md', children, footer,
  closeOnBackdrop = true, closeOnEsc = true, className, bodyClassName, hideClose = false,
}) {
  const ref = useOverlay(open, onClose, { closeOnEsc })
  if (!open) return null

  return createPortal(
    <Backdrop onClose={onClose} closeOnBackdrop={closeOnBackdrop}
      className="flex items-start justify-center overflow-y-auto p-4 sm:p-6 md:py-[8vh]">
      <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}
        className={cn(
          'relative w-full bg-white rounded-2xl shadow-pop animate-pop-in outline-none flex flex-col max-h-[calc(100vh-3rem)]',
          WIDTH[size], className,
        )}>
        {(title || !hideClose) && (
          <div className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-gray-100 shrink-0">
            <div className="min-w-0 flex-1">
              {title && <h2 className="text-base font-semibold text-gray-900 leading-6">{title}</h2>}
              {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
            </div>
            {!hideClose && <IconButton icon={X} label="Закрыть (Esc)" onClick={onClose} className="-mr-2 -mt-1" />}
          </div>
        )}
        <div className={cn('px-6 py-5 overflow-y-auto', bodyClassName)}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50/60 rounded-b-2xl shrink-0">
            {footer}
          </div>
        )}
      </div>
    </Backdrop>,
    document.body,
  )
}

/**
 * Боковая панель справа: расшифровка и правка, не теряя из виду страницу под ней.
 */
export function Drawer({
  open = true, onClose, title, subtitle, width = 'w-[min(640px,100vw)]', children, footer,
  closeOnBackdrop = true, className, bodyClassName,
}) {
  const ref = useOverlay(open, onClose)
  if (!open) return null

  return createPortal(
    <Backdrop onClose={onClose} closeOnBackdrop={closeOnBackdrop} className="flex justify-end">
      <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}
        className={cn('h-full bg-white shadow-pop animate-slide-in outline-none flex flex-col', width, className)}>
        <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-base font-semibold text-gray-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
          </div>
          <IconButton icon={X} label="Закрыть (Esc)" onClick={onClose} className="-mr-1.5" />
        </div>
        <div className={cn('flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 shrink-0">{footer}</div>}
      </div>
    </Backdrop>,
    document.body,
  )
}
