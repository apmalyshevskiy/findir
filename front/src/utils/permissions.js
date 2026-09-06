/**
 * Права текущего пользователя в интерфейсе.
 *
 * Это подсказка, а не защита: решение принимает сервер, здесь мы только не
 * показываем то, чего человек всё равно не сможет сделать. Прятать кнопку
 * вместо запрета было бы самообманом — запрос уходит по адресу, а не по кнопке.
 *
 * Карта прав приезжает вместе с пользователем при входе и в /me и лежит рядом
 * с ним в localStorage — см. accounts.js.
 */

const LEVELS = { none: 0, view: 1, edit: 2 }

const user = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}') } catch { return {} }
}

/** Карта «раздел → уровень» */
export const permissions = () => user().permissions || {}

export const isAdmin = () => !!user().is_admin

export const roleName = () => user().role?.name || ''

/** Хватает ли прав: edit покрывает view, view не покрывает edit */
export const can = (section, level = 'view') => {
  // Пока прав нет (старая сессия до появления должностей) — не мешаем
  // работать: сервер всё равно проверит и откажет, если что
  const map = permissions()
  if (!section || Object.keys(map).length === 0) return true

  return (LEVELS[map[section]] ?? 0) >= (LEVELS[level] ?? 2)
}

/** Раздел виден в меню */
export const canView = (section) => can(section, 'view')

/** В разделе можно менять */
export const canEdit = (section) => can(section, 'edit')
