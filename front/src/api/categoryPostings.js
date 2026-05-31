import api from './client'

export const getCategoryPostings = (params) => api.get('/category-postings', { params })
export const createCategoryPosting = (data) => api.post('/category-postings', data)
export const updateCategoryPosting = (id, data) => api.put(`/category-postings/${id}`, data)
export const deleteCategoryPosting = (id) => api.delete(`/category-postings/${id}`)
