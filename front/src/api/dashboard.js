import api from './client'

// Сводка по периодам. params: { date, project_id }
export const getDashboardSummary = (params) => api.get('/dashboard/summary', { params })

// Показатели за произвольный период. params: { date_from, date_to, project_id }
export const getDashboardMetrics = (params) => api.get('/dashboard/metrics', { params })

// Дневной ряд выручки по проектам. params: { date, days, project_id }
export const getRevenueSeries = (params) => api.get('/dashboard/revenue-series', { params })

// Раскладка виджетов дашборда (персонально на пользователя).
export const getDashboardLayout = () => api.get('/dashboard/layout')
export const saveDashboardLayout = (layout) => api.put('/dashboard/layout', { layout })
