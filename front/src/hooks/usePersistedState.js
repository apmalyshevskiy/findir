import { useEffect, useState } from 'react'
import { tenantKey } from '../utils/storage'

/**
 * useState, переживающий переход на другую страницу и перезагрузку.
 *
 * Настройки отчёта (аналитики, группировки, фильтры) сбрасывались при каждом
 * уходе со страницы, и собирать их приходилось заново.
 *
 * Для несериализуемых значений (Set, Map) передайте serialize/deserialize:
 *   usePersistedState('osv:hierarchy', new Set(), {
 *     serialize:   s => [...s],
 *     deserialize: a => new Set(a),
 *   })
 */
export default function usePersistedState(name, initial, opts = {}) {
  const { serialize = (v) => v, deserialize = (v) => v } = opts
  const storageKey = tenantKey(name)

  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw !== null) return deserialize(JSON.parse(raw))
    } catch {
      // повреждённое значение — молча берём значение по умолчанию
    }
    return initial
  })

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(serialize(state)))
    } catch {
      // приватный режим / переполнено — работаем без запоминания
    }
  }, [storageKey, state])

  return [state, setState]
}
