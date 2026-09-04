import api from './client'

export const getBalanceItemsList = () => api.get('/balance-items')
export const createBalanceItem = (data) => api.post('/balance-items', data)
export const updateBalanceItem = (id, data) => api.put(`/balance-items/${id}`, data)
export const deleteBalanceItem = (id) => api.delete(`/balance-items/${id}`)

// Каталог системных счетов: что можно завести и что уже заведено
export const getAccountCatalog = () => api.get('/balance-items/catalog')
export const addAccountsFromCatalog = (codes) => api.post('/balance-items/catalog', { codes })
