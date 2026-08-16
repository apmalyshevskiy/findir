import axios from 'axios'
import { listAccounts, forgetAccount, activeTenantId } from '../utils/accounts'
import { requestStarted, requestFinished } from './progress'

const api = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
})

// Добавляем токен к каждому запросу. Уже заданный заголовок не перебиваем:
// так можно обратиться от имени другой компании из книжки (например, погасить
// её токен при отключении), не переключая активную сессию.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // Считаем запросы «в полёте» — по этому счётчику живёт полоска загрузки
  // вверху экрана. Ждём ответ сервера, а не отрисовку, поэтому место одно
  // на всё приложение: страницам об индикации думать не нужно
  requestStarted()
  return config
}, (error) => {
  requestFinished()
  return Promise.reject(error)
})

// Обработка 401
api.interceptors.response.use(
  (response) => {
    requestFinished()
    return response
  },
  (error) => {
    requestFinished()
    if (error.response?.status === 401) {
      // Выбывает конкретная сессия, а не все сразу: у финдиректора в книжке
      // несколько компаний, и протухший токен одной не повод разлогинивать
      // его везде. Опознаём по токену запроса, а не по активной компании —
      // запрос мог уходить от имени другой.
      const used = String(error.config?.headers?.Authorization || '').replace(/^Bearer\s+/, '')
      const dead = listAccounts().find(a => a.token === used)

      forgetAccount(dead ? dead.tenant.id : activeTenantId())

      // Осталась хоть одна компания — остаёмся в приложении, иначе на вход
      window.location.assign(localStorage.getItem('token') ? '/dashboard' : '/login')
    }
    return Promise.reject(error)
  }
)

export default api
