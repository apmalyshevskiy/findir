import { useEffect, useState } from 'react'

/**
 * Секундомер ожидания: сколько уже идёт загрузка и пора ли её показывать.
 *
 * `visible` включается не сразу, а через `delay` — быстрые ответы не должны
 * давать вспышку индикатора: мельтешение раздражает сильнее, чем его отсутствие.
 * Секунды нужны на долгих отчётах: с ними видно, что процесс идёт, а не завис.
 */
export default function useElapsed(active, delay = 400) {
  const [ms, setMs] = useState(0)

  useEffect(() => {
    if (!active) {
      // Сбрасываем следующим тиком, а не прямо здесь: setState в теле эффекта
      // тянет за собой лишний каскад рендеров
      const t = setTimeout(() => setMs(0), 0)
      return () => clearTimeout(t)
    }
    const started = Date.now()
    const t = setInterval(() => setMs(Date.now() - started), 100)
    return () => clearInterval(t)
  }, [active])

  return { visible: active && ms >= delay, seconds: ms / 1000 }
}
