import api from './client'

/**
 * Отправить TXT-файл на парсинг.
 * Возвращает: { header, cash_info_id, projects, rows, stats }
 */
export const parseBankStatement = (file) => {
  const form = new FormData()
  form.append('file', file)
  return api.post('/bank-statements/parse', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}
