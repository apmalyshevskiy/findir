import api from './client'

export const getOperations = (params) => api.get('/operations', { params })
export const createOperation = (data) => api.post('/operations', data)
export const updateOperation = (id, data) => api.put(`/operations/${id}`, data)
export const deleteOperation = (id) => api.delete(`/operations/${id}`)
export const getBalanceItems = () => api.get('/balance-items')

export const getBalanceSheet = (params) => api.get('/balance-sheet', { params })
