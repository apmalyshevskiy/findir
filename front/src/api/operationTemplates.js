import api from './client'

export const getTemplates = () => api.get('/operation-templates')
export const createTemplate = (name, payload) => api.post('/operation-templates', { name, payload })
export const useTemplate = (id) => api.post(`/operation-templates/${id}/use`)
export const deleteTemplate = (id) => api.delete(`/operation-templates/${id}`)
