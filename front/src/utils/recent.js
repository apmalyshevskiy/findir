/**
 * Недавно открытые объекты — чтобы вернуться к тому, что только что смотрел.
 *
 * Нарочно не на сервере и нарочно не в журнале изменений. Это разные вещи:
 * журнал — запись факта о данных, общая для компании и вечная; список недавних
 * — личное удобство навигации, живёт день и никого, кроме владельца, не
 * касается. Свести их в одну таблицу значило бы, во-первых, утопить аудит
 * (просмотров в сотню раз больше правок), во-вторых, завести слежку за тем,
 * кто на что смотрел.
 *
 * Отсюда и хранение: localStorage. Ни запроса на каждый клик, ни таблицы, ни
 * миграции; открывается мгновенно и переживает случайное закрытие вкладки.
 */

const KEY   = 'findir:recent'
const LIMIT = 30

/** Ключ свой у каждой компании: списки баз не должны смешиваться */
const storageKey = () => {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    return `${KEY}:${user.tenant_id || 'default'}:${user.id || 0}`
  } catch {
    return `${KEY}:default`
  }
}

export const readRecent = () => {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) || '[]')
  } catch {
    return []
  }
}

/**
 * Запомнить открытый объект.
 *
 * Повторное открытие поднимает запись наверх, а не плодит дубли: список нужен,
 * чтобы вернуться, а не чтобы посчитать заходы.
 *
 * @param entity 'operation' | 'document' | 'info'
 * @param id     идентификатор объекта
 * @param title  чем он подписан в списке
 */
export const pushRecent = (entity, id, title) => {
  if (!entity || !id) return

  try {
    const list = readRecent().filter(r => !(r.entity === entity && String(r.id) === String(id)))

    list.unshift({ entity, id, title: String(title || '').slice(0, 120), at: Date.now() })
    localStorage.setItem(storageKey(), JSON.stringify(list.slice(0, LIMIT)))

    // Шапка слушает это событие: она не перечитывает хранилище на каждый
    // рендер, а список должен пополняться на глазах
    window.dispatchEvent(new CustomEvent('findir:recent'))
  } catch {
    /* приватный режим или переполненное хранилище — обойдёмся без списка */
  }
}

export const clearRecent = () => {
  try {
    localStorage.removeItem(storageKey())
    window.dispatchEvent(new CustomEvent('findir:recent'))
  } catch { /* нечего чистить */ }
}

export const RECENT_LABEL = {
  operation: 'Операция',
  document:  'Документ',
  info:      'Справочник',
}
