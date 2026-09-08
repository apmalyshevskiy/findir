import { tenantKey } from './storage'

/**
 * Недавно выбранные элементы справочников.
 *
 * Подряд обычно выбирают одно и то же: три накладные от одного поставщика,
 * пять расходов по одной статье. Искать их в дереве заново — самая частая
 * потеря времени при вводе.
 *
 * Показываем, но **не подставляем**. Автоподстановка в учёте опасна: не
 * заметили — и операция ушла на прошлого контрагента; сумма при этом
 * правильная, и ошибка всплывает только на сверке.
 *
 * Ключ по типу справочника, а не по конкретному полю. «Контрагент» в документе
 * и в операции — один справочник и одна привычка; раздели мы их по полям,
 * список был бы пуст при первом заходе в каждое поле, то есть почти всегда.
 *
 * Хранится в браузере: между устройствами не переносится. Заводить ради этого
 * таблицу и синхронизацию — несоразмерно; понадобится, вернёмся.
 */

/** Сколько помним. Больше семи — уже не «недавние», а второй справочник. */
const LIMIT = 7

const key = (type) => tenantKey(`recent:info:${type}`)

/** @return {Array<number>} id в порядке от последнего к более раннему */
export function getRecent(type) {
  if (!type) return []

  try {
    const raw = localStorage.getItem(key(type))
    const ids = raw ? JSON.parse(raw) : []

    return Array.isArray(ids) ? ids : []
  } catch {
    // Приватный режим или мусор в хранилище — работаем без недавних
    return []
  }
}

/** Поднять элемент наверх списка недавних. */
export function pushRecent(type, id) {
  if (!type || id === null || id === undefined || id === '') return

  const value = Number(id)
  if (Number.isNaN(value)) return

  try {
    const next = [value, ...getRecent(type).filter(x => x !== value)].slice(0, LIMIT)
    localStorage.setItem(key(type), JSON.stringify(next))
  } catch {
    // Переполнено или запрещено — поле просто работает как раньше
  }
}

/**
 * Недавние, приведённые к элементам справочника.
 *
 * Фильтруем по фактическому наличию: элемент могли удалить или он не того типа,
 * что сейчас в поле, — показывать его было бы обманом.
 */
export function recentItems(type, items = []) {
  const ids = getRecent(type)
  if (!ids.length || !items.length) return []

  const byId = new Map(items.map(i => [Number(i.id), i]))

  return ids.map(id => byId.get(id)).filter(Boolean)
}
