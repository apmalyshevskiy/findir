import api from './client'

// Шаблоны наполнения справочников: при регистрации справочники пустые,
// тенант наполняет их сам — кнопкой «Заполнить».
export const getDictionaryTemplates = () => api.get('/dictionary-templates')

// Состав шаблона с пометкой, что уже есть в базе (предпросмотр)
export const getDictionaryTemplate = (key) => api.get(`/dictionary-templates/${key}`)

export const applyDictionaryTemplate = (key) => api.post(`/dictionary-templates/${key}/apply`)
