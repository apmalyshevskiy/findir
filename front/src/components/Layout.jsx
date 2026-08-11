import { useNavigate, useLocation } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import TenantSwitcher from './TenantSwitcher'
import { listAccounts, clearAccounts } from '../utils/accounts'

/**
 * Общая сетка шапки и страницы. Ширина и поля заданы в одном месте: пока они
 * жили порознь, меню шло от края окна, а карточки — от края колонки контента.
 */
const SHELL = 'max-w-[1400px] mx-auto px-4 md:px-6'

export default function Layout({ children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const user = JSON.parse(localStorage.getItem('user') || '{}')

  const [openMenu, setOpenMenu] = useState(null)   // label открытого выпадающего раздела
  const navRef = useRef(null)

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

  const nav = [
    { path: '/dashboard',        label: 'Дашборд' },
    { path: '/operations',       label: 'Операции' },
    { path: '/documents',        label: 'Документы' },
    { path: '/balance-sheet',    label: 'Оборотка' },
    { path: '/bank-statement',   label: 'Выписка' },
    { path: '/data-import',      label: 'Загрузка' },
    { path: '/budget',           label: 'Бюджет' },
    { path: '/payment-calendar', label: 'Календарь' },
    {
      label: 'Фонды',
      children: [
        { path: '/fund-planning', label: 'Планирование' },
        { path: '/fund-schemes',  label: 'Модели распределения' },
      ],
    },
    {
      label: 'Настройки',
      children: [
        { path: '/projects',             label: 'Проекты' },
        { path: '/balance-items',        label: 'План счетов' },
        { path: '/info',                 label: 'Справочники' },
        { path: '/classification-rules', label: 'Настройка правил' },
        { path: '/acquiring-fee-rules', label: 'Эквайринг' },
        { path: '/edit-lock-date',       label: 'Дата запрета' },
        { path: '/integrations',         label: 'Интеграции' },
        { path: '/backup',               label: 'Архивная копия' },
      ],
    },
  ]

  // активен ли раздел с подпунктами (для подсветки)
  const isGroupActive = (item) =>
    item.children?.some(c => location.pathname === c.path)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Полоса шапки во всю ширину, а её содержимое — по той же сетке, что и
          страница ниже: иначе меню и карточки живут по разным левым краям */}
      <header className="bg-white border-b border-gray-200">
        <div className={`${SHELL} py-3 flex flex-wrap justify-between items-center gap-x-3 gap-y-2`}>
          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-blue-900">FINDIR</h1>

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
                    {openMenu === n.label && (
                      <div className="absolute left-0 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                        {n.children.map(c => (
                          <button
                            key={c.path}
                            onClick={() => { setOpenMenu(null); navigate(c.path) }}
                            className={
                              location.pathname === c.path
                                ? 'block w-full text-left px-4 py-2 text-sm font-medium bg-blue-50 text-blue-900'
                                : 'block w-full text-left px-4 py-2 text-sm text-gray-600 hover:bg-gray-50'
                            }
                          >
                            {c.label}
                          </button>
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
            <span className="text-sm text-gray-500">{user.name}</span>
            <button onClick={logout} className="text-sm text-gray-400 hover:text-red-600 transition-colors">
              Выйти
            </button>
          </div>
        </div>
      </header>

      <main className={`${SHELL} py-4 md:py-6`}>{children}</main>
    </div>
  )
}
