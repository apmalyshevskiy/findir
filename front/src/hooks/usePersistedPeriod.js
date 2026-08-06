import { useEffect, useState } from 'react'
import { presetRange } from '../utils/period'
import { tenantKey } from '../utils/storage'

/**
 * Выбранный период отчёта, переживающий перезагрузку страницы.
 *
 * Хранится по тенанту и по странице: у ОСВ и списка операций периоды свои —
 * их обычно смотрят в разной глубине, и общий период сбивал бы с толку.
 *
 * Пресеты («Месяц», «Квартал») сохраняются ключом, а не датами: в сентябре
 * «Месяц» должен означать сентябрь, а не застывший август. Конкретно выбранный
 * календарный месяц или произвольные даты сохраняются как есть.
 */
export default function usePersistedPeriod(pageKey, defaultPreset = 'month') {
  const storageKey = tenantKey(`period:${pageKey}`)

  const [period, setPeriod] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (saved?.preset && saved.preset !== 'custom') {
        return { ...presetRange(saved.preset), preset: saved.preset }
      }
      if (saved && typeof saved.from === 'string' && typeof saved.to === 'string') {
        return { from: saved.from, to: saved.to, preset: 'custom' }
      }
    } catch {
      // повреждённое значение в localStorage — просто берём период по умолчанию
    }
    return { ...presetRange(defaultPreset), preset: defaultPreset }
  })

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(period))
    } catch {
      // приватный режим / переполнено — работаем без запоминания
    }
  }, [storageKey, period])

  return [period, setPeriod]
}
