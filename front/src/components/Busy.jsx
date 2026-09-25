import { useEffect, useState } from 'react'
import { subscribeProgress } from '../api/progress'
import useElapsed from '../hooks/useElapsed'

/**
 * Индикация ожидания — общая на всё приложение.
 *
 * На своей машине отчёт считается секундами, и неподвижный экран в это время
 * читается как «зависло»: пользователь жмёт ещё раз или уходит со страницы.
 * Поэтому показываем три разные вещи:
 *
 *   TopBusy      — «запрос ушёл», видно везде и сразу;
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
 * Кольцо ожидания: две дуги, навстречу друг другу и с разной скоростью.
 *
 * Дуги, а не полные окружности: у замкнутого кольца не видно, вращается оно
 * или стоит. Разрыв — это и есть то, что показывает движение.
 *
 * Длина дуги задаётся через strokeDasharray долей от длины окружности, чтобы
 * при смене радиуса разрыв оставался тем же на глаз.
 */
export function Ring({ size = 20, className = 'text-blue-600' }) {
  const arc = (r, part) => {
    const len = 2 * Math.PI * r
    return `${len * part} ${len}`
  }

  // transformBox нужен вместе с transformOrigin: без него отсчёт идёт от угла
  // svg, и дуга не вращается, а ездит по кругу
  const spin = (sec, reverse) => ({
    transformBox: 'fill-box',
    transformOrigin: 'center',
    animation: `findir-arc ${sec}s linear infinite${reverse ? ' reverse' : ''}`,
  })

  return (
    <svg className={`${className} flex-shrink-0`} width={size} height={size}
      viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="19" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"
        strokeDasharray={arc(19, 0.7)} className="opacity-90" style={spin(1.2, false)} />
      <circle cx="24" cy="24" r="11" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"
        strokeDasharray={arc(11, 0.4)} className="opacity-45" style={spin(0.9, true)} />
    </svg>
  )
}

/**
 * Общий индикатор работы — по всем запросам к API сразу.
 *
 * Был полоской во всю ширину экрана, ползущей к 90%: точного прогресса у нас
 * нет, сервер отвечает одним куском, и проценты в ней были выдуманные.
 * Кружок ничего не обещает — говорит только «работаем», и это правда.
 *
 * По центру экрана и крупно: в углу кружок легко пропустить, а ждут его как
 * раз тогда, когда смотрят в середину страницы. Клики он не перехватывает —
 * `pointer-events-none`, — и страницу не затемняет: работать под ним можно.
 * Когда содержимое как раз нужно закрыть — пересчёт уже показанных цифр, —
 * для этого есть BusyOverlay.
 *
 * Задержка 400 мс: быстрые ответы проходят незаметно, мельтешение посреди
 * экрана хуже, чем его отсутствие. Секундомер после полутора секунд — на
 * долгих отчётах по нему видно, что процесс идёт, а не завис.
 */
export function TopBusy() {
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeProgress(n => setBusy(n > 0)), [])

  const { visible, seconds } = useElapsed(busy, 400)
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none flex items-center justify-center">
      <div className="flex items-center gap-3 rounded-full bg-white/95 border border-gray-200 shadow-xl px-4 py-3"
        style={{ animation: 'findir-appear 220ms ease-out' }}>
        <Ring size={40} />
        {seconds >= 1.5 && (
          <span className="text-sm tabular-nums text-gray-400 pr-1">{fmtSec(seconds)}</span>
        )}
      </div>
    </div>
  )
}
