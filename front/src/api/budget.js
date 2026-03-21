import api from './client'

// Документы бюджета
export const getBudgetDocuments = (params) => api.get('/budget-documents', { params })
export const createBudgetDocument = (data) => api.post('/budget-documents', data)
export const updateBudgetDocument = (id, data) => api.put(`/budget-documents/${id}`, data)
export const deleteBudgetDocument = (id) => api.delete(`/budget-documents/${id}`)

// Отчёт план-факт
export const getBudgetReport = (id, params) => api.get(`/budget-report/${id}`, { params })

// Upsert строк плана
export const upsertBudgetItem = (data) => api.put('/budget-items/upsert', data)
export const upsertBudgetItems = (budgetDocumentId, items) =>
  api.put('/budget-items/upsert', { budget_document_id: budgetDocumentId, items })

// Upsert начальных остатков
export const upsertOpeningBalance = (data) => api.put('/budget-opening-balances/upsert', data)
