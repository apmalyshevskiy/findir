import api from './client'

/**
 * Проводки из 1С:Бухгалтерии.
 *
 * Файл уходит на сервер дважды — на просмотр и на загрузку. Держать его между
 * запросами значило бы заводить хранилище ради одной минуты жизни данных, а
 * так вторая отправка идёт из того же объекта File, что уже лежит в браузере.
 */

export const getOneCSettings  = () => api.get('/onec/settings')
export const saveOneCSettings = (data) => api.put('/onec/settings', data)

const upload = (url, file, extra = {}) => {
  const form = new FormData()
  form.append('file', file)

  Object.entries(extra).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach(v => form.append(`${key}[]`, v))
    else if (value !== null && value !== undefined) form.append(key, value)
  })

  return api.post(url, form, { headers: { 'Content-Type': 'multipart/form-data' } })
}

export const previewOneCPostings = (file) => upload('/onec/postings/preview', file)

export const importOneCPostings = (file, only) => upload('/onec/postings/import', file, { only })
