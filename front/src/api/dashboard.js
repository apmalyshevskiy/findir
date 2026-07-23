import api from './client'

// Сводка по периодам. params: { date, project_id }
export const getDashboardSummary = (params) => api.get('/dashboard/summary', { params })
