import api from './client'

/**
 * История диалогов с помощником.
 *
 * noProgress, как и у остальных вызовов ИИ: автосохранение идёт фоном, и
 * зажигать из-за него полоску загрузки у края окна — только отвлекать.
 */
const silent = { noProgress: true }

export const listDialogs  = ()             => api.get('/ai/dialogs', silent)
export const getDialog    = (id)           => api.get(`/ai/dialogs/${id}`, silent)
export const createDialog = (turns, history) => api.post('/ai/dialogs', { turns, history }, silent)
export const saveDialog   = (id, turns, history) => api.put(`/ai/dialogs/${id}`, { turns, history }, silent)
export const removeDialog = (id)           => api.delete(`/ai/dialogs/${id}`, silent)
