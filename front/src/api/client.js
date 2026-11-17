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
  // на всё приложение: страницам об индикации думать не нужно.
  //
  // Кроме тех, кто просит не считать (noProgress): ИИ думает десятками секунд,
  // и ползущая всё это время полоска у края окна только отвлекает — у таких
  // запросов ожидание показывается там, где человек его ждёт
  if (!config.noProgress) requestStarted()
  return config
}, (error) => {
  if (!error.config?.noProgress) requestFinished()
  return Promise.reject(error)
})

// Обработка 401
api.interceptors.response.use(
  (response) => {
    if (!response.config?.noProgress) requestFinished()
    return response
  },
  (error) => {
    if (!error.config?.noProgress) requestFinished()

    // Не хватило прав. Показываем причину сразу: страницы обрабатывают свои
    // ошибки по-разному, и без этого человек увидел бы пустой экран или
    // невнятное «ошибка сохранения» вместо «вам это не разрешено»
    if (error.response?.status === 403) {
      const message = error.response?.data?.message || 'Недостаточно прав для этого действия'
      window.dispatchEvent(new CustomEvent('findir:forbidden', { detail: message }))
    }

    if (error.response?.status === 401) {
      // Выбывает конкретная сессия, а не все сразу: у финдиректора в книжке
      // несколько компаний, и протухший токен одной не повод разлогинивать
      // его везде. Опознаём по токену запроса, а не по активной компании —
      // запрос мог уходить от имени другой.
      const used = String(error.config?.headers?.Authorization || '').replace(/^Bearer\s+/, '')
      const dead = listAccounts().find(a => a.token === used)

      // Повторные 401 той же пачки запросов сессию уже не трогают — иначе
      // каждый следующий отказ «забывал» бы уже следующую, живую компанию
      const tenantId = dead ? dead.tenant.id : (used === localStorage.getItem('token') ? activeTenantId() : null)
      if (!tenantId) return Promise.reject(error)
      const name = (dead?.tenant || listAccounts().find(a => a.tenant?.id === tenantId)?.tenant)?.name

      forgetAccount(tenantId)

      // Осталась хоть одна компания — остаёмся в приложении, иначе на вход.
      // Причину говорим после перезагрузки: молча пропавшая компания или
      // внезапный экран входа выглядят как сбой
      const left = !!localStorage.getItem('token')
      try {
        sessionStorage.setItem('findir:notice', left && name
          ? `Сессия в «${name}» завершилась — компания убрана из списка. Чтобы вернуть её, войдите в неё снова.`
          : 'Сессия завершилась — войдите снова.')
      } catch { /* приватный режим — просто без пояснения */ }
      window.location.assign(left ? '/dashboard' : '/login')
    }
    return Promise.reject(error)
  }
)

export default api
