import api from './client'

export const getOperations = (params) => api.get('/operations', { params })
export const createOperation = (data) => api.post('/operations', data)
export const updateOperation = (id, data) => api.put(`/operations/${id}`, data)
export const deleteOperation = (id) => api.delete(`/operations/${id}`)

// Проведение: непроведённая операция остаётся в списке, но не попадает в обороты
export const setOperationPosting = (id, isPosted) =>
  api.post(`/operations/${id}/posting`, { is_posted: isPosted })
export const getBalanceItems = () => api.get('/balance-items')

export const getBalanceSheet = (params) => api.get('/balance-sheet', { params })
