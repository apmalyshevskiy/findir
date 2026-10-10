import api from './client'

// Демо-данные: что можно залить и заливка. Только в чистую компанию
export const getDemoDatasets = () => api.get('/demo/datasets')

// Генератор заводит тысячи записей — ждём дольше обычного запроса
export const seedDemo = (dataset) => api.post('/demo/seed', { dataset }, { timeout: 600000 })
