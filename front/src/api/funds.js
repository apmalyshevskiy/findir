import api from './client'

// Факт за неделю по выбранной модели: приход и расход по фондам из движений денег
export const getFundCalc = (scheme_id, week_start) => api.get('/funds/calc', { params: { scheme_id, week_start } })

// Акт финансового планирования (документ на неделю + модель)
export const getFundPlanDoc = (scheme_id, week_start) => api.get('/fund-plan-docs', { params: { scheme_id, week_start } })
export const saveFundPlanDoc = (payload) => api.put('/fund-plan-docs', payload)
