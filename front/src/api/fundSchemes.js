import api from './client'

// Модели распределения (система фондов) и фонды внутри них
export const getFundSchemes = () => api.get('/fund-schemes')
export const getFundScheme = (id) => api.get(`/fund-schemes/${id}`)
export const createFundScheme = (data) => api.post('/fund-schemes', data)
export const updateFundScheme = (id, data) => api.put(`/fund-schemes/${id}`, data)
export const deleteFundScheme = (id) => api.delete(`/fund-schemes/${id}`)
