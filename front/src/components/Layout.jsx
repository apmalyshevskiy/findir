import { useNavigate, useLocation } from 'react-router-dom'
import { Fragment, useState, useRef, useEffect } from 'react'
import TenantSwitcher from './TenantSwitcher'
import Logo from './Logo'
import { TopProgress } from './Busy'
import api from '../api/client'
import { listAccounts, clearAccounts } from '../utils/accounts'
import { canView, roleName } from '../utils/permissions'

/**
 * Общая сетка шапки и страницы. Ширина и поля заданы в одном месте: пока они
 * жили порознь, меню шло от края окна, а карточки — от края колонки контента.
 */
const SHELL = 'max-w-[1400px] mx-auto px-4 md:px-6'

export default function Layout({ children }) {
  const navigate = useNavigate()
  const location = useLocation()

  // Пользователь с правами лежит в localStorage с момента входа. Освежаем его
  // при каждом заходе на страницу: администратор мог сменить должность, и
  // человек не должен ради этого перелогиниваться
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}') } catch { return {} }
  })

  useEffect(() => {
    api.get('/me')
      .then(r => {
        if (!r.data?.user) return
        localStorage.setItem('user', JSON.stringify(r.data.user))
        setUser(r.data.user)
      })
      .catch(() => { /* 401 обработает перехватчик, остальное не мешает работать */ })
  }, [location.pathname])

  const [openMenu, setOpenMenu] = useState(null)   // label открытого выпадающего раздела
  const navRef = useRef(null)

  // Отказ по правам — плашкой поверх страницы. Ловим событие от axios: так
  // сообщение появится с любой страницы, не требуя от каждой своей обработки
  const [forbidden, setForbidden] = useState('')
  useEffect(() => {
    const onForbidden = (e) => {
      setForbidden(e.detail)
      setTimeout(() => setForbidden(''), 6000)
    }
    window.addEventListener('findir:forbidden', onForbidden)
    return () => window.removeEventListener('findir:forbidden', onForbidden)
  }, [])

  // Закрытие выпадающего раздела по клику вне навигации
  useEffect(() => {
    const onDocClick = (e) => {
      if (navRef.current && !navRef.current.contains(e.target)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  /**
   * «Выйти» — из всех подключённых компаний сразу: за общим компьютером это
   * ожидаемое поведение, а оставить чужую базу открытой было бы неприятным
   * сюрпризом. Отключить одну компанию можно в списке рядом с её названием.
   */
  const logout = () => {
    const accounts = listAccounts()
    import('../api/client').then(({ default: api }) => {
      const all = accounts.map(a =>
        api.post('/logout', {}, { headers: { Authorization: `Bearer ${a.token}` } }).catch(() => {})
      )
      Promise.all(all).finally(() => {
        clearAccounts()
        localStorage.clear()
        navigate('/login')
      })
    })
  }

  // У пунктов меню указан раздел прав: закрытые не показываем. Настоящая
  // проверка — на сервере, здесь лишь бы не звать человека в закрытую дверь
  const nav = [
    // Помощник первым и сам по себе: с него часто начинают ввод
    { path: '/ai', label: 'AI-помощник', section: 'ai' },
    // Меню собрано по тому, что человек делает: сначала вводят, потом смотрят,
    // потом планируют. Раньше эти же семь пунктов лежали в ряд, и разница между
    // «завести операцию» и «посмотреть оборотку» ничем не показывалась
    {
      label: 'Учёт',
      children: [
        { path: '/operations', label: 'Операции',    section: 'operations' },
        { path: '/documents',  label: 'Документы',   section: 'documents' },
        // Контрагенты, статьи, сотрудники, кассы — это содержимое операций и
        // документов, а не настройка системы: заводят их по ходу работы
        { path: '/info',       label: 'Справочники', section: 'dictionaries' },
      ],
    },
    {
      label: 'Отчётность',
      children: [
        { path: '/dashboard',     label: 'Дашборд',  section: 'dashboard' },
        { path: '/balance-sheet', label: 'Оборотка', section: 'reports' },
      ],
    },
    {
      label: 'Планирование',
      children: [
        { path: '/budget',           label: 'Бюджет',               section: 'budget' },
        { path: '/payment-calendar', label: 'Платёжный календарь',  section: 'budget' },
        { path: '/fund-planning',    label: 'Фонды',                section: 'budget' },
        { path: '/fund-schemes',     label: 'Модели распределения', section: 'budget' },
      ],
    },
    // Всё, что приходит в базу извне, — в одном разделе: и разовая загрузка
    // файла выписки, и обмен с учётной системой вместе с его настройкой.
    // Порознь это выглядело как разные умения, хотя задача одна
    {
      label: 'Обмен данными',
      children: [
        { path: '/bank-statement', label: 'Банковская выписка',        section: 'exchange' },
        { path: '/onec-postings',  label: 'Проводки из 1С',            section: 'exchange' },
        { path: '/data-import',    label: 'Загрузка из учётных систем', section: 'exchange' },
        { path: '/integrations',   label: 'Настройка интеграций',       section: 'exchange' },
      ],
    },
    // Настройки разбиты подзаголовками внутри самого списка: пунктов набралось
    // на десяток, и сплошным столбцом в них уже приходилось вчитываться.
    // Подзаголовок показывается, только если в группе уцелел хоть один пункт
    // после проверки прав
    {
      label: 'Настройки',
      children: [
        { path: '/projects',             label: 'Проекты',           section: 'dictionaries', group: 'Справочники' },
        { path: '/balance-items',        label: 'План счетов',       section: 'dictionaries', group: 'Справочники' },
        { path: '/document-types',       label: 'Виды документов',   section: 'dictionaries', group: 'Справочники' },

        { path: '/users',                label: 'Пользователи',      section: 'users',    group: 'Доступ' },
        { path: '/roles',                label: 'Должности',         section: 'users',    group: 'Доступ' },
        // Дата запрета — тоже про доступ, только не «кому», а «до какого числа»
        { path: '/edit-lock-date',       label: 'Дата запрета',      section: 'settings', group: 'Доступ' },

        { path: '/classification-rules', label: 'Настройка правил',  section: 'dictionaries', group: 'Прочее' },
        { path: '/acquiring-fee-rules',  label: 'Эквайринг',         section: 'settings',     group: 'Прочее' },
        // «Интеграции» переехали в «Обмен данными» — там же, где сама загрузка
        { path: '/ai-usage',             label: 'Расход на ИИ',      section: 'settings',     group: 'Прочее' },
        { path: '/backup',               label: 'Архивная копия',    section: 'backup',       group: 'Прочее' },
      ],
    },
  ].map(item => item.children
    ? { ...item, children: item.children.filter(c => canView(c.section)) }
    : item
  ).filter(item => item.children ? item.children.length > 0 : canView(item.section))

  // активен ли раздел с подпунктами (для подсветки)
  const isGroupActive = (item) =>
    item.children?.some(c => location.pathname === c.path)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Общая полоска загрузки: любой запрос к API виден сразу, на какой бы
          странице он ни ушёл */}
      <TopProgress />

      {/* Полоса шапки во всю ширину, а её содержимое — по той же сетке, что и
          страница ниже: иначе меню и карточки живут по разным левым краям */}
      <header className="bg-white border-b border-gray-200">
        <div className={`${SHELL} py-3 flex flex-wrap justify-between items-center gap-x-3 gap-y-2`}>
          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            {/* Знак не ссылка: раздел «Дашборд» открыт не всякой должности,
                и логотип, ведущий в отказ по правам, — плохая кнопка */}
            <div className="flex items-center gap-2 shrink-0">
              <Logo size={24} />
              {/* Разрядка — вместо отдельного шрифта под логотип: слово из шести
                  прописных без неё выглядит сжатым рядом со знаком */}
              <h1 className="text-xl font-semibold tracking-[0.09em] text-blue-900">FINDIR</h1>
            </div>

            {/* Название компании и переключение баз — см. TenantSwitcher */}
            <TenantSwitcher />
            {/* Тариф (trial/plan) переедет в настройки → подписка */}

            <nav ref={navRef} className="flex flex-wrap gap-1 md:ml-2">
              {nav.map(n => (
                n.children ? (
                  <div key={n.label} className="relative">
                    <button
                      onClick={() => setOpenMenu(openMenu === n.label ? null : n.label)}
                      className={
                        (isGroupActive(n) || openMenu === n.label)
                          ? 'px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-900 text-white flex items-center gap-1'
                          : 'px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 flex items-center gap-1'
                      }
                    >
                      {n.label}
                      <span className="text-[10px]">▾</span>
                    </button>
                    {/* Ширина списка — по самому длинному пункту: названия
                        разделов бывают в три слова, и перенос строки в узком
                        списке читался бы как два разных пункта */}
                    {openMenu === n.label && (
                      <div className="absolute left-0 mt-1 w-max min-w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                        {n.children.map((c, i) => (
                          <Fragment key={c.path}>
                            {/* Подзаголовок — у первого уцелевшего пункта группы.
                                Считаем по уже отфильтрованному списку, поэтому
                                группа, из которой правами вычистили всё,
                                не оставляет висящего заголовка */}
                            {c.group && c.group !== n.children[i - 1]?.group && (
                              <div className={`px-4 pb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400 ${
                                i === 0 ? 'pt-1' : 'pt-2.5 mt-1 border-t border-gray-100'
                              }`}>
                                {c.group}
                              </div>
                            )}
                            <button
                              onClick={() => { setOpenMenu(null); navigate(c.path) }}
                              className={
                                location.pathname === c.path
                                  ? 'block w-full text-left px-4 py-2 text-sm font-medium bg-blue-50 text-blue-900'
                                  : 'block w-full text-left px-4 py-2 text-sm text-gray-600 hover:bg-gray-50'
                              }
                            >
                              {c.label}
                            </button>
                          </Fragment>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    key={n.path}
                    onClick={() => navigate(n.path)}
                    className={
                      location.pathname === n.path
                        ? 'px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-900 text-white'
                        : 'px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100'
                    }
                  >
                    {n.label}
                  </button>
                )
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">
              {user.name}
              {/* Должность рядом с именем: человек должен понимать, почему
                  часть разделов ему не видна */}
              {roleName() && <span className="text-gray-400"> · {roleName()}</span>}
            </span>
            <button onClick={logout} className="text-sm text-gray-400 hover:text-red-600 transition-colors">
              Выйти
            </button>
          </div>
        </div>
      </header>

      {forbidden && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] max-w-lg px-4 py-3 bg-amber-50 border border-amber-300 text-amber-900 text-sm rounded-lg shadow-lg flex items-start gap-3">
          <span>{forbidden}</span>
          <button onClick={() => setForbidden('')} className="text-amber-400 hover:text-amber-700">✕</button>
        </div>
      )}

      <main className={`${SHELL} py-4 md:py-6`}>{children}</main>
    </div>
  )
}
