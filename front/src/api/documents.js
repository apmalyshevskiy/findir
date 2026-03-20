import api from './client'

export const getDocuments  = (params) => api.get('/documents', { params })
export const getDocument   = (id)     => api.get(`/documents/${id}`)
export const createDocument = (data)  => api.post('/documents', data)
export const updateDocument = (id, data) => api.put(`/documents/${id}`, data)
export const deleteDocument = (id)    => api.delete(`/documents/${id}`)
export const postDocument   = (id)    => api.post(`/documents/${id}/post`)
export const cancelDocument = (id)    => api.post(`/documents/${id}/cancel`)
