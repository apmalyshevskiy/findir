import api from './client'

export const getAiStatus = () => api.get('/ai/status')

// history: [{ role: 'user' | 'assistant', content: string }] — контекст диалога
export const parseOperation = (text, model, history) =>
  api.post('/ai/parse-operation', { text, model, history })

// links: [{ flow_id, expense_id }] — проставить статьям ДДС статью расхода
export const applyLinks = (links) => api.post('/ai/apply-links', { links })

export const transcribeAudio = (blob) => {
  const fd = new FormData()
  fd.append('audio', blob, 'voice.webm')
  return api.post('/ai/transcribe', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
