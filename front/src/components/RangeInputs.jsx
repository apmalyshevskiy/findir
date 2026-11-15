import { useEffect, useRef, useState } from 'react'

/**
 * Правдоподобная ли граница периода.
 *
 * Пока год набирают, браузер отдаёт его обрубки, и не все они выглядят
 * обрубками: 2026 из 32026 — это 3202 на предпоследнем нажатии, дата со
 * вполне настоящим годом. Отбирать по ней так же бессмысленно, как по третьему
 * году нашей эры, поэтому границы ставим по здравому смыслу учётной системы, а
 * не по тому, что способен разобрать Date.
 */
const plausible = (v, type) => {
  if (!v) return true                       // пустая граница — это «без ограничения»
  if (!(type === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(v)) return false
  const y = Number(v.slice(0, 4))
  return y >= 1900 && y <= 2100
}

/**
 * Через сколько применяется значение, выбранное мышью в календарике.
 *
 * Только для мыши: там дата приходит сразу целой, ждать нечего, а фокус из
 * поля не уходит, и без этого срока отчёт не обновился бы вовсе. Набор с
 * клавиатуры не применяется по времени ни через сколько — любая пауза рано
 * или поздно приходится на середину ввода, и запрос уходит по недописанной
 * дате. Клавиатуру завершает Enter или уход из полей.
 */
const PICKER_DELAY = 400

/**
 * Пара полей «с … по …»: обе границы правятся вместе и применяются разом.
 *
 * <input type="date"> и <input type="month"> шлют событие на каждое изменение
 * любого сегмента. Пока год меняют с 2026 на 2027, браузер успевает прислать
 * 0002, 0020, 0202 и только потом 2027 — и каждое значение уходило в отбор. На
 * журнале в несколько тысяч операций или на отчёте бюджета это четыре запроса
 * и четыре полных перерисовки там, где нужен один.
 *
 * Поэтому набранное живёт здесь, а наружу уходит, когда ввод закончен: по
 * Enter или когда фокус покинул оба поля. Правка «с» и правка «по» — это одно
 * действие «сменил период», и запрос на него тоже один: перейдя из первого
 * поля во второе, человек отбор не трогает.
 *
 * type='month' — границы в виде YYYY-MM: так устроен бюджет, где колонка это
 * месяц целиком и день в периоде ничего не значит.
 */
export default function RangeInputs({
  value, onApply, inputClass, type = 'date', fromLabel = 'с', toLabel = 'по', labelClass = 'text-xs text-gray-400',
}) {
  const applied = { from: value.from || '', to: value.to || '' }
  const [draft, setDraft] = useState(applied)
  const [shown, setShown] = useState(applied)
  const timer = useRef(null)
  const box = useRef(null)
  // Набирают с клавиатуры или выбрали мышью: от этого зависит, можно ли
  // применять период по времени
  const typed = useRef(false)

  // Период сменили снаружи — стрелками, пресетом, сменой документа.
  // Подхватываем прямо в рендере, а не эффектом: иначе поля показали бы
  // старые даты лишним кадром, а при листании стрелками это заметно
  if (shown.from !== applied.from || shown.to !== applied.to) {
    setShown(applied)
    setDraft(applied)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  const ok = (v) => plausible(v, type)
  const ready = ok(draft.from) && ok(draft.to)
  const dirty = draft.from !== applied.from || draft.to !== applied.to

  const apply = (next) => {
    clearTimeout(timer.current)
    typed.current = false
    if (!ok(next.from) || !ok(next.to)) return
    if (next.from === applied.from && next.to === applied.to) return
    onApply(next)
  }

  /**
   * Правка одной границы. Если диапазон вывернулся (начало позже конца) —
   * подтягиваем вторую границу, а не блокируем ввод: иначе сдвинуть период
   * вперёд было бы нельзя, «с» упиралось бы в старое «по».
   */
  const edit = (edge, val) => {
    const next = { ...draft, [edge]: val }

    if (ok(val) && next.from && next.to && next.from > next.to) {
      if (edge === 'from') next.to = val
      else next.from = val
    }
    setDraft(next)

    clearTimeout(timer.current)
    // Набор с клавиатуры по времени не применяем совсем: человек печатает с
    // любыми паузами, и срок, которого хватает одному, другому придётся на
    // середину года. Такой ввод заканчивают Enter или уход из полей
    if (!typed.current && ok(next.from) && ok(next.to)) {
      timer.current = setTimeout(() => apply(next), PICKER_DELAY)
    }
  }

  // Фокус ушёл из обеих границ — ввод закончен. Переход из «с» в «по» фокус
  // оставляет внутри, и отбор на полпути не меняется
  const handleBlur = (e) => {
    // Перешли во второе поле — ввод продолжается, отложенный отбор отменяем:
    // иначе он сработал бы с полпути, по одной исправленной границе
    if (box.current?.contains(e.relatedTarget)) { clearTimeout(timer.current); return }
    clearTimeout(timer.current)
    typed.current = false
    // Ушли, не дописав год, — возвращаем то, по чему собран отчёт: иначе поле
    // показывало бы 0003, а цифры относились бы к другому периоду
    if (!ready) { setDraft(applied); return }
    apply(draft)
  }

  const min = type === 'month' ? '1900-01' : '1900-01-01'
  const max = type === 'month' ? '2100-12' : '2100-12-31'

  return (
    <div ref={box} className="flex items-center gap-1.5"
      onBlur={handleBlur}
      onKeyDown={e => {
        // Любое нажатие в полях — признак ручного набора: дальше период
        // меняется только по Enter или по уходу отсюда
        typed.current = true
        if (e.key === 'Enter')  { e.preventDefault(); if (ready) apply(draft) }
        if (e.key === 'Escape') { clearTimeout(timer.current); typed.current = false; setDraft(applied) }
      }}>
      {fromLabel && <span className={labelClass}>{fromLabel}</span>}
      <input type={type} value={draft.from} min={min} max={max}
        onChange={e => edit('from', e.target.value)}
        className={`${inputClass} ${dirty ? 'border-blue-400' : ''}`} />
      {toLabel && <span className={labelClass}>{toLabel}</span>}
      <input type={type} value={draft.to} min={min} max={max}
        onChange={e => edit('to', e.target.value)}
        className={`${inputClass} ${dirty ? 'border-blue-400' : ''}`} />

      {/* Пока набранное не применено, на экране ещё прошлый период — и об
          этом должно быть видно, а не догадываться по цифрам */}
      {dirty && (
        <span className="text-[11px] text-blue-600 whitespace-nowrap" title="Применить период">
          Enter ↵
        </span>
      )}
    </div>
  )
}
