import { useNavigate, useLocation } from 'react-router-dom'

export default function Layout({ children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const tenant = JSON.parse(localStorage.getItem('tenant') || '{}')
  const user   = JSON.parse(localStorage.getItem('user') || '{}')

  const logout = () => {
    import('../api/client').then(({ default: api }) => {
      api.post('/logout').finally(() => {
        localStorage.clear()
        navigate('/login')
      })
    })
  }

  const nav = [
    { path: '/info',             label: 'Справочники' },
    { path: '/dashboard',        label: 'Операции' },
    { path: '/documents',        label: 'Документы' },
    { path: '/balance-sheet',    label: 'Оборотка' },
    { path: '/bank-statement',   label: 'Выписка' },
    { path: '/budget',           label: 'Бюджет' },
    { path: '/payment-calendar', label: 'Календарь' },
  ]

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-blue-900">FINDIR</h1>
          <span className="text-gray-300">|</span>
          <span className="text-gray-600 text-sm font-medium">{tenant.name}</span>
          <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">{tenant.plan}</span>
          <nav className="flex gap-1 ml-2">
            {nav.map(n => (
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
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user.name}</span>
          <button onClick={logout} className="text-sm text-gray-400 hover:text-red-600 transition-colors">
            Выйти
          </button>
        </div>
      </header>
      <main className="p-6 max-w-6xl mx-auto">{children}</main>
    </div>
  )
}
