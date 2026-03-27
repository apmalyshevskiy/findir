import api from './client'

export const getBudgetDocuments = (params) => api.get('/budget-documents', { params })
export const createBudgetDocument = (data) => api.post('/budget-documents', data)
export const updateBudgetDocument = (id, data) => api.put(`/budget-documents/${id}`, data)
export const deleteBudgetDocument = (id) => api.delete(`/budget-documents/${id}`)

export const getBudgetReport = (id, params) => api.get(`/budget-report/${id}`, { params })

export const getBudgetItems = (params) => api.get('/budget-items', { params })
export const createBudgetItem = (data) => api.post('/budget-items', data)
export const updateBudgetItem = (id, data) => api.put(`/budget-items/${id}`, data)
export const deleteBudgetItem = (id) => api.delete(`/budget-items/${id}`)

export const upsertOpeningBalance = (data) => api.put('/budget-opening-balances/upsert', data)
