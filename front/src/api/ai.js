import api from './client'

export const getAiStatus = () => api.get('/ai/status')

// history: [{ role: 'user' | 'assistant', content: string }] — контекст диалога
export const parseOperation = (text, model, history) =>
  api.post('/ai/parse-operation', { text, model, history })

// Файл (фото чека, счёт, выписка xlsx/csv) → черновики операций
export const parseFile = (file, text, history) => {
  const fd = new FormData()
  fd.append('file', file)
  if (text) fd.append('text', text)
  ;(history || []).forEach((h, i) => {
    fd.append(`history[${i}][role]`, h.role)
    fd.append(`history[${i}][content]`, h.content)
  })
  return api.post('/ai/parse-file', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

// links: [{ flow_id, expense_id }] — проставить статьям ДДС статью расхода
export const applyLinks = (links) => api.post('/ai/apply-links', { links })

export const transcribeAudio = (blob) => {
  const fd = new FormData()
  fd.append('audio', blob, 'voice.webm')
  return api.post('/ai/transcribe', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
