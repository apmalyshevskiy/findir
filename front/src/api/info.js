import api from './client'

export const getInfo = (params) => api.get('/info', { params })
export const createInfo = (data) => api.post('/info', data)
export const updateInfo = (id, data) => api.put(`/info/${id}`, data)
export const deleteInfo = (id) => api.delete(`/info/${id}`)

// Массовая правка: только внутри одного справочника, только родитель и вид
export const previewInfoBulk = (ids, set) => api.post('/info/bulk-preview', { ids, set })
export const applyInfoBulk   = (ids, set) => api.post('/info/bulk-update',  { ids, set })
