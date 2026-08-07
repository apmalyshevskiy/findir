import api from './client'

export const getBackupSummary = () => api.get('/backup/summary')

// Скачивание идёт через axios, а не по прямой ссылке: токен лежит в
// localStorage и в заголовке, обычный <a href> его не передаст.
export const downloadBackup = () =>
  api.get('/backup/export', { responseType: 'blob' })

// Принимаем и .json.gz, и распакованный .json — сервер определяет по сигнатуре
export const inspectBackup = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post('/backup/inspect', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

export const importBackup = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('confirm', '1')
  return api.post('/backup/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
