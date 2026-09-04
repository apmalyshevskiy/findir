import api from './client'

// Виды документов: что становится шапкой, что строками и куда это проводится.
// active=1 — только включённые: их показывает список документов вкладками
export const getDocumentTypes   = (params) => api.get('/document-types', { params })
export const createDocumentType = (data)   => api.post('/document-types', data)
export const updateDocumentType = (id, d)  => api.put(`/document-types/${id}`, d)
export const deleteDocumentType = (id)     => api.delete(`/document-types/${id}`)
