import { useEffect, useRef, useState } from 'react'
import { subscribeProgress } from '../api/progress'
import useElapsed from '../hooks/useElapsed'

/**
 * Индикация ожидания — общая на всё приложение.
 *
 * На своей машине отчёт считается секундами, и неподвижный экран в это время
 * читается как «зависло»: пользователь жмёт ещё раз или уходит со страницы.
 * Поэтому показываем три разные вещи:
 *
 *   TopProgress  — «запрос ушёл», видно везде и сразу;
 *   SkeletonRows — «здесь будет таблица», когда показывать ещё нечего;
 *   BusyOverlay  — «цифры пересчитываются», когда старые данные ещё на экране.
 *
 * Быстрые ответы индикацией не мигают: всё, что укладывается в задержку
 * появления, проходит незаметно — мельтешение хуже, чем его отсутствие.
 */

/** «3,4 с» — с секундами понятнее, чем с бесконечной крутилкой */
const fmtSec = (s) => `${s.toFixed(1).replace('.', ',')} с`

export function Spinner({ className = 'w-3.5 h-3.5' }) {
  return (
    <svg className={`${className} animate-spin text-blue-700 flex-shrink-0`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-4a6 6 0 0 0-6-6V2z" />
    </svg>
  )
}

/** Строчка «идёт загрузка» рядом с фильтрами: спиннер, подпись и секундомер */
export function BusyLabel({ active, children = 'Загружаю данные', delay = 400, className = '' }) {
  const { visible, seconds } = useElapsed(active, delay)
  if (!visible) return null
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs text-gray-500 ${className}`}>
      <Spinner />
      <span>{children}</span>
      {seconds >= 1.5 && <span className="tabular-nums text-gray-400">{fmtSec(seconds)}</span>}
    </span>
  )
}

/**
 * Заглушка на месте будущих строк. Показываем, когда данных ещё нет вовсе:
 * так видно, что грузится именно таблица, и вёрстка не прыгает при появлении.
 */
export function SkeletonRows({ rows = 6, height = 'h-10', className = '' }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i}
          className={`${height} rounded-lg bg-gray-100 animate-pulse`}
          style={{ opacity: Math.max(0.15, 1 - i * 0.12) }} />
      ))}
    </div>
  )
}

/**
 * Полупрозрачная плашка поверх уже показанных данных: цифры на экране пока
 * старые, и это должно быть видно. Родителю нужен `relative`.
 *
 * `hint` появляется, когда ждём долго, — обычно это подсказка, чем сузить
 * запрос (период, аналитика), потому что серверу мы помочь уже не можем.
 */
export function BusyOverlay({ active, label = 'Обновляю данные', hint, delay = 300, className = '' }) {
  const { visible, seconds } = useElapsed(active, delay)
  if (!visible) return null
  return (
    <div className={`absolute inset-0 z-20 bg-white/60 flex items-start justify-center pt-12 ${className}`}>
      <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-white border border-gray-200 shadow-sm">
        <Spinner className="w-4 h-4" />
        <div>
          <div className="text-sm text-gray-700">{label}</div>
          {hint && seconds >= 4 && (
            <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>
          )}
        </div>
        {seconds >= 1.5 && (
          <span className="text-xs tabular-nums text-gray-400 ml-1">{fmtSec(seconds)}</span>
        )}
      </div>
    </div>
  )
}

/**
 * Полоска загрузки поверх шапки — по всем запросам к API сразу.
 *
 * Точного прогресса у нас нет (сервер отвечает одним куском), поэтому полоска
 * ползёт к 90% и ждёт ответа: честно показывает «работаем», не обещая срока.
 * По завершении добегает до конца и гаснет.
 */
export function TopProgress() {
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState(false)
  const widthRef = useRef(0)

  const set = (v) => { widthRef.current = v; setWidth(v) }

  useEffect(() => subscribeProgress(n => setActive(n > 0)), [])

  useEffect(() => {
    if (active) {
      // Первый шаг делает тот же таймер: 0 → 11% через 200 мс, поэтому
      // мгновенные ответы полоской не мигают. Дальше замедляемся у 90% —
      // полоска не упирается в край на первой же секунде долгого отчёта
      const t = setInterval(() => set(widthRef.current + (90 - widthRef.current) * 0.12), 200)
      return () => clearInterval(t)
    }
    if (widthRef.current === 0) return
    // Добегаем до конца и гаснем. Через таймер, а не сразу: браузеру нужен
    // отдельный кадр, иначе переход не отрисуется
    const done = setTimeout(() => set(100), 16)
    const gone = setTimeout(() => set(0), 400)
    return () => { clearTimeout(done); clearTimeout(gone) }
  }, [active])

  if (width === 0) return null

  return (
    <div className="fixed top-0 left-0 right-0 h-0.5 z-[100] pointer-events-none">
      <div
        className="h-full bg-blue-600 transition-all duration-200 ease-out"
        style={{ width: `${width}%`, opacity: width === 100 ? 0 : 1 }}
      />
    </div>
  )
}
