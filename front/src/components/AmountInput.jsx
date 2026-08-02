import { forwardRef, useRef } from 'react'

// Разбивка на триады прямо во время ввода (курсор сохраняется по числу цифр слева).
const groupInt = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const fmtTyping = (v) => {
  let s = v == null ? '' : String(v)
  if (s === '') return ''
  const neg = s[0] === '-' ? '-' : ''
  s = s.replace('-', '')
  const dot = s.indexOf('.')
  return dot === -1 ? neg + groupInt(s) : neg + groupInt(s.slice(0, dot)) + ',' + s.slice(dot + 1)
}

/**
 * Поле ввода суммы: показывает «150 000», наружу отдаёт чистое «150000».
 * onChange получает строку без пробелов (десятичный разделитель — точка).
 */
const AmountInput = forwardRef(function AmountInput(
  { value, onChange, className, placeholder, disabled, onKeyDown, onBlur, required },
  forwardedRef
) {
  const innerRef = useRef(null)
  const setRefs = (el) => {
    innerRef.current = el
    if (typeof forwardedRef === 'function') forwardedRef(el)
    else if (forwardedRef) forwardedRef.current = el
  }

  const onInput = (e) => {
    const el = e.target
    const digitsBefore = el.value.slice(0, el.selectionStart).replace(/\D/g, '').length
    const clean = el.value.replace(/\s/g, '').replace(',', '.')
    if (clean !== '' && clean !== '-' && !/^-?\d*\.?\d*$/.test(clean)) return
    onChange(clean)
    const formatted = fmtTyping(clean)
    requestAnimationFrame(() => {
      if (!innerRef.current) return
      let seen = 0, pos = 0
      while (pos < formatted.length && seen < digitsBefore) { if (/\d/.test(formatted[pos])) seen++; pos++ }
      innerRef.current.setSelectionRange(pos, pos)
    })
  }

  return (
    <input ref={setRefs} type="text" inputMode="decimal" className={className} placeholder={placeholder}
      disabled={disabled} required={required} value={fmtTyping(value)} onChange={onInput}
      onKeyDown={onKeyDown} onBlur={onBlur} />
  )
})

export default AmountInput
