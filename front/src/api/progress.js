/**
 * Счётчик незавершённых запросов к API.
 *
 * Нужен верхней полоске загрузки: она общая на всё приложение и не должна
 * знать, какая страница что запросила. Живёт отдельно от axios-клиента, чтобы
 * компоненты подписывались на прогресс, не втягивая за собой клиента и токены.
 */

let inFlight = 0
const subscribers = new Set()

const notify = () => subscribers.forEach(fn => fn(inFlight))

export const requestStarted = () => { inFlight += 1; notify() }

// Ниже нуля не опускаемся: перехватчик ошибки может сработать по запросу,
// который уже посчитали завершённым
export const requestFinished = () => { inFlight = Math.max(0, inFlight - 1); notify() }

/** Подписка на изменение числа запросов «в полёте». Возвращает отписку. */
export const subscribeProgress = (fn) => {
  subscribers.add(fn)
  fn(inFlight)
  return () => subscribers.delete(fn)
}
