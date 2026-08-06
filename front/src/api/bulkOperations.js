import api from './client'

// Массовая правка операций, выбранных галочками в списке.
// side — куда писать аналитику: 'debit' | 'credit' | 'any'
export const previewBulk = (ids, set, side = 'any') =>
  api.post('/operations/bulk-preview', { ids, set, side })

export const applyBulkEdit = (ids, set, side = 'any') =>
  api.post('/operations/bulk-update', { ids, set, side })

// Журнал массовых правок — общий с правками от ИИ
export const getBulkLog = () => api.get('/operations/bulk-log')

export const revertBulkEdit = (logId) => api.post(`/operations/bulk-log/${logId}/revert`)
