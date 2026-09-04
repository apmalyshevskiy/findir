import api from './client'

/**
 * Обращения к ИИ.
 *
 * Все они помечены noProgress: верхнюю полоску загрузки они не зажигают.
 * Модель думает десятками секунд, и ползущая всё это время полоска у края
 * окна только отвлекает — ожидание ИИ показывается там, где его ждут:
 * в самом чате и на кнопке разбора выписки.
 */
const silent = { noProgress: true }

export const getAiStatus = () => api.get('/ai/status', silent)

// history: [{ role: 'user' | 'assistant', content: string }] — контекст диалога
export const parseOperation = (text, model, history) =>
  api.post('/ai/parse-operation', { text, model, history }, silent)

// Файл (фото чека, счёт, выписка xlsx/csv) → черновики операций
export const parseFile = (file, text, history) => {
  const fd = new FormData()
  fd.append('file', file)
  if (text) fd.append('text', text)
  ;(history || []).forEach((h, i) => {
    fd.append(`history[${i}][role]`, h.role)
    fd.append(`history[${i}][content]`, h.content)
  })
  return api.post('/ai/parse-file', fd, { ...silent, headers: { 'Content-Type': 'multipart/form-data' } })
}

// Массовая правка существующих операций (спецификацию готовит ИИ)
export const applyBulk = (filter, set) => api.post('/ai/apply-bulk', { filter, set }, silent)
export const revertBulk = (logId) => api.post(`/ai/bulk-log/${logId}/revert`, {}, silent)

// Выписка: доразбор строк, которые не покрылись правилами (пачками до 20)
export const classifyStatement = (rows) => api.post('/ai/classify-statement', { rows }, silent)

// Создать правила классификации, подтверждённые пользователем
export const applyRules = (rules) => api.post('/ai/apply-rules', { rules }, silent)

// links: [{ flow_id, expense_id }] — проставить статьям ДДС статью расхода
export const applyLinks = (links) => api.post('/ai/apply-links', { links }, silent)

export const transcribeAudio = (blob) => {
  const fd = new FormData()
  fd.append('audio', blob, 'voice.webm')
  return api.post('/ai/transcribe', fd, { ...silent, headers: { 'Content-Type': 'multipart/form-data' } })
}
