/**
 * Ключи локального хранилища, привязанные к тенанту.
 *
 * Настройки отчётов у каждой компании свои: у одного тенанта в ОСВ раскрыты
 * контрагенты, у другого — статьи ДДС. Без привязки к тенанту они бы
 * перемешивались при смене аккаунта в том же браузере.
 */
export const tenantId = () => {
  try {
    return JSON.parse(localStorage.getItem('tenant') || '{}').id || 'default'
  } catch {
    return 'default'
  }
}

export const tenantKey = (name) => `findir:${tenantId()}:${name}`
