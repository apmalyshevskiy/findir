import api from './client'

export const getClassificationRules = (params) => api.get('/classification-rules', { params })
export const createClassificationRule = (data) => api.post('/classification-rules', data)
export const updateClassificationRule = (id, data) => api.put(`/classification-rules/${id}`, data)
export const deleteClassificationRule = (id) => api.delete(`/classification-rules/${id}`)
