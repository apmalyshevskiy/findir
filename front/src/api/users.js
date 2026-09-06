import api from './client'

// Пользователи компании — те, кто входит в систему
// (не путать со справочником «Сотрудники»: там аналитика для зарплаты)
export const getUsers        = ()          => api.get('/users')
export const createUser      = (data)      => api.post('/users', data)
export const updateUser      = (id, data)  => api.put(`/users/${id}`, data)
export const setUserPassword = (id, password) => api.post(`/users/${id}/password`, { password })
export const deleteUser      = (id)        => api.delete(`/users/${id}`)

// Должности — наборы прав по разделам
export const getRoles   = ()         => api.get('/roles')
export const createRole = (data)     => api.post('/roles', data)
export const updateRole = (id, data) => api.put(`/roles/${id}`, data)
export const deleteRole = (id)       => api.delete(`/roles/${id}`)

// Смена собственного пароля
export const changeMyPassword = (current_password, password) =>
  api.post('/me/password', { current_password, password, password_confirmation: password })
