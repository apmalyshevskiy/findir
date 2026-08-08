import api from './client'

// Схема полей каждого типа — по ней собирается форма настроек,
// поэтому новая учётная система не требует правок фронтенда
export const getIntegrationTypes = () => api.get('/integrations/types')

export const getIntegrations   = ()        => api.get('/integrations')
export const getIntegration    = (id)      => api.get(`/integrations/${id}`)
export const createIntegration = (data)    => api.post('/integrations', data)
export const updateIntegration = (id, d)   => api.put(`/integrations/${id}`, d)
export const deleteIntegration = (id)      => api.delete(`/integrations/${id}`)

export const testIntegration      = (id) => api.post(`/integrations/${id}/test`)
export const getRemoteDictionaries = (id) => api.get(`/integrations/${id}/dictionaries`)
export const getIntegrationRuns    = (id) => api.get(`/integrations/${id}/runs`)

// Загрузка идёт синхронно и может занять минуты — свой таймаут
export const runIntegrationSync = (id, data) =>
  api.post(`/integrations/${id}/sync`, data, { timeout: 300000 })
