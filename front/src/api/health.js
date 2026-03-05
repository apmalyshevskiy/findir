import api from './client'

// Получение статуса системы (наш эндпоинт в Laravel)
export const getHealth = () => api.get('/health')