/**
 * Книжка подключённых компаний.
 *
 * Финдиректор ведёт несколько клиентов, у каждого — своя база и свой токен.
 * Держим список сессий рядом и переключаем активную, вместо того чтобы
 * заново входить каждый раз.
 *
 * Активная сессия по-прежнему лежит в ключах token/tenant/user — на них
 * завязано всё остальное приложение, и трогать его не пришлось.
 */

const BOOK = 'findir:accounts'

const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback }
  catch { return fallback }
}

/** Текущая сессия как запись книжки (или null, если не вошли). */
const current = () => {
  const token  = localStorage.getItem('token')
  const tenant = read('tenant', null)
  return token && tenant?.id ? { token, tenant, user: read('user', {}) } : null
}

/**
 * Список подключённых компаний.
 *
 * Если книжки нет, а сессия есть — значит вход был до появления списка;
 * заводим книжку из текущей сессии, чтобы она не потерялась.
 */
export const listAccounts = () => {
  const saved = read(BOOK, null)
  if (Array.isArray(saved) && saved.length) return saved

  const now = current()
  if (!now) return []
  localStorage.setItem(BOOK, JSON.stringify([now]))
  return [now]
}

export const activeTenantId = () => read('tenant', {})?.id || null

/** Запомнить сессию и сделать её активной. */
export const rememberAccount = ({ token, tenant, user }) => {
  const rest = listAccounts().filter(a => a.tenant?.id !== tenant.id)
  const book = [...rest, { token, tenant, user }]
  localStorage.setItem(BOOK, JSON.stringify(book))
  applyActive({ token, tenant, user })
  return book
}

/** Переключиться на компанию из книжки. */
export const activateAccount = (tenantId) => {
  const acc = listAccounts().find(a => a.tenant?.id === tenantId)
  if (!acc) return false
  applyActive(acc)
  return true
}

/**
 * Убрать компанию из книжки. Если убрали активную — активной становится
 * первая из оставшихся, иначе пользователь оказался бы с пустой сессией.
 */
export const forgetAccount = (tenantId) => {
  const book = listAccounts().filter(a => a.tenant?.id !== tenantId)
  localStorage.setItem(BOOK, JSON.stringify(book))

  if (activeTenantId() === tenantId) {
    if (book.length) applyActive(book[0])
    else clearActive()
  }
  return book
}

export const clearAccounts = () => {
  localStorage.removeItem(BOOK)
  clearActive()
}

function applyActive({ token, tenant, user }) {
  localStorage.setItem('token', token)
  localStorage.setItem('tenant', JSON.stringify(tenant))
  localStorage.setItem('user', JSON.stringify(user || {}))
}

function clearActive() {
  localStorage.removeItem('token')
  localStorage.removeItem('tenant')
  localStorage.removeItem('user')
}
