import api from './client'

/**
 * Отчётность для собственника: баланс на дату и движение денег за период.
 *
 * Считает сервер по тому же регистру, что и оборотку, — здесь только запрос.
 */
export const getBalanceReport = (params) => api.get('/reports/balance', { params })

export const getCashFlowReport = (params) => api.get('/reports/cash-flow', { params })
