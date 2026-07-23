import api from './client'

// Правила эквайринг-свода (settings.acquiring_fee_rules).
// GET возвращает { data: rules[], formats: string[], defaults: rules[] }
export const getAcquiringFeeRules = () =>
  api.get('/settings/acquiring-fee-rules')

// PUT принимает весь набор правил целиком (замена).
export const updateAcquiringFeeRules = (rules) =>
  api.put('/settings/acquiring-fee-rules', { rules })

// Дата запрета редактирования (закрытый период).
// GET возвращает { date: 'YYYY-MM-DD' | null }
export const getEditLockDate = () =>
  api.get('/settings/edit-lock-date')

// PUT принимает { date } — пустое значение снимает запрет.
export const updateEditLockDate = (date) =>
  api.put('/settings/edit-lock-date', { date: date || null })
