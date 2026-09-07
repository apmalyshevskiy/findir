import api from './client'

/**
 * Проводки из 1С:Бухгалтерии.
 *
 * Файл уходит на сервер дважды — на просмотр и на загрузку. Держать его между
 * запросами значило бы заводить хранилище ради одной минуты жизни данных, а
 * так вторая отправка идёт из того же объекта File, что уже лежит в браузере.
 */

export const getOneCSettings  = (params = {}) => api.get('/onec/settings', { params })
export const saveOneCSettings = (data) => api.put('/onec/settings', data)

/** Привязка субконто: mode = bind | skip | auto (снять привязку). */
export const saveOneCAnalytics = (data) => api.put('/onec/analytics-map', data)

const upload = (url, file, extra = {}) => {
  const form = new FormData()
  form.append('file', file)

  Object.entries(extra).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach(v => form.append(`${key}[]`, v))
    else if (value !== null && value !== undefined && value !== '') form.append(key, value)
  })

  return api.post(url, form, { headers: { 'Content-Type': 'multipart/form-data' } })
}

export const previewOneCPostings = (file, integrationId) =>
  upload('/onec/postings/preview', file, { integration_id: integrationId })

export const importOneCPostings = (file, only, integrationId) =>
  upload('/onec/postings/import', file, { only, integration_id: integrationId })
