import { INFO_LABELS } from './infoLabels'

/**
 * Слот аналитики счёта: какие справочники он принимает.
 *
 * Зеркало серверного App\Services\AnalyticSlots — то же правило, но для
 * интерфейса. Слот хранит не тип, а набор:
 *
 *   null                — слота нет, поля в форме не будет;
 *   'partner'           — один справочник, как было всегда;
 *   'partner,employee'  — только эти два;
 *   'any'               — любой справочник.
 */

export const ANY = 'any'

export const TYPES = ['partner', 'employee', 'department', 'cash', 'flow', 'expenses', 'product', 'revenue']

export const isAnySlot = (declared) => declared === ANY

/** Набор типов слота. Для «любого» — все известные */
export const slotTypes = (declared) => {
  if (!declared) return []
  if (isAnySlot(declared)) return TYPES

  return String(declared).split(',').map(t => t.trim()).filter(t => TYPES.includes(t))
}

export const slotAccepts = (declared, type) => !!type && (isAnySlot(declared) || slotTypes(declared).includes(type))

/**
 * Подпись поля.
 *
 * Один тип — как раньше («Контрагент»); несколько — через точку, чтобы было
 * видно, из чего выбирать; любой — просто «Аналитика»: перечислять все восемь
 * в заголовке поля бессмысленно.
 */
export const slotLabel = (declared) => {
  if (!declared) return ''
  if (isAnySlot(declared)) return 'Аналитика'

  return slotTypes(declared).map(t => INFO_LABELS[t] || t).join(' · ')
}

/** Все типы всех слотов счёта — что подгружать в кэш справочников */
export const slotAllTypes = (account) => [...new Set(
  [1, 2, 3].flatMap(n => slotTypes(account?.[`info_${n}_type`]))
)]

/**
 * Готовые свойства InfoSelect для слота: список, типы, перезагрузка кэша.
 *
 * `onCreated` принимает тип справочника — его берём у самого заведённого
 * элемента: в слоте с набором он может быть любым из разрешённых.
 */
export const slotSelect = (declared, cache, onCreated) => {
  const types = slotTypes(declared)

  return {
    items:     slotItems(declared, cache) || [],
    infoType:  types.length === 1 ? types[0] : undefined,
    infoTypes: types,
    onItemCreated: (item) => onCreated?.(item?.type || types[0]),
  }
}

/** Элементы всех разрешённых типов из кэша «тип → элементы» */
export const slotItems = (declared, cache) => {
  const types = slotTypes(declared)
  if (types.length === 1) return cache[types[0]]

  // Пока не пришёл хоть один справочник — считаем, что грузимся: пустой
  // список читался бы как «выбирать не из чего»
  const loaded = types.filter(t => cache[t])
  if (!loaded.length) return undefined

  return loaded.flatMap(t => cache[t] || [])
}
