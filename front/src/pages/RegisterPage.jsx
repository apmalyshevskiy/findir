import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../api/client'

export default function RegisterPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    company_name: '', domain: '', name: '', email: '',
    password: '', password_confirmation: ''
  })
  const [domainStatus, setDomainStatus] = useState(null) // null | 'checking' | 'ok' | 'taken' | 'error'
  const [domainEdited, setDomainEdited] = useState(false) // пользователь вручную менял домен
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const checkTimer = useRef(null)

  const BASE_DOMAIN = 'localhost' // TODO: взять из env или конфига

  // Транслитерация русских букв в латиницу
  const transliterate = (str) => {
    const map = {
      'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
      'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
      'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
      'щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    }
    return str.toLowerCase().split('').map(c => map[c] ?? c).join('')
  }

  // Сделать slug из названия компании (на клиенте, без запроса)
  const makeSlug = (name) => {
    return transliterate(name)
      .replace(/[^a-z0-9]+/g, '-')  // не буквы/цифры → дефис
      .replace(/^-+|-+$/g, '')       // убрать дефисы по краям
      .slice(0, 50)
  }

  // При вводе названия компании — автоформирование домена
  useEffect(() => {
    if (domainEdited) return
    if (!form.company_name) { setForm(f => ({ ...f, domain: '' })); setDomainStatus(null); return }

    const slug = makeSlug(form.company_name)
    if (!slug) return
    setForm(f => ({ ...f, domain: slug }))

    if (checkTimer.current) clearTimeout(checkTimer.current)
    checkTimer.current = setTimeout(async () => {
      if (slug.length < 3) return
      try {
        const res = await api.get('/check-domain', { params: { domain: slug } })
        setDomainStatus(res.data.available ? 'ok' : 'taken')
      } catch {
        setDomainStatus('ok')
      }
    }, 400)
  }, [form.company_name])

  // При ручном изменении домена — live-проверка уникальности
  const handleDomainChange = (value) => {
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, '')
    setForm(f => ({ ...f, domain: clean }))
    setDomainEdited(true)
    setDomainStatus('checking')

    if (checkTimer.current) clearTimeout(checkTimer.current)
    if (!clean || clean.length < 3) { setDomainStatus(clean ? 'error' : null); return }

    checkTimer.current = setTimeout(async () => {
      try {
        const res = await api.get('/check-domain', { params: { domain: clean } })
        setDomainStatus(res.data.available ? 'ok' : 'taken')
      } catch {
        setDomainStatus(null)
      }
    }, 400)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (form.password !== form.password_confirmation) { setError('Пароли не совпадают'); return }
    if (domainStatus === 'taken') { setError('Этот домен уже занят'); return }
    if (!form.domain || form.domain.length < 3) { setError('Укажите корректный домен'); return }

    setLoading(true)
    try {
      const res = await api.post('/register', form)
      localStorage.setItem('token', res.data.token)
      localStorage.setItem('tenant', JSON.stringify(res.data.tenant))
      localStorage.setItem('user', JSON.stringify(res.data.user))
      navigate('/dashboard')
    } catch (err) {
      const errors = err.response?.data?.errors
      if (errors) setError(Object.values(errors).flat().join(', '))
      else setError(err.response?.data?.message || 'Ошибка регистрации')
    } finally {
      setLoading(false)
    }
  }

  const ic = 'w-full px-4 py-2.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm'

  const domainBorderClass = () => {
    if (domainStatus === 'ok')      return 'border-green-400 focus:ring-green-400'
    if (domainStatus === 'taken')   return 'border-red-400 focus:ring-red-400'
    if (domainStatus === 'error')   return 'border-amber-400 focus:ring-amber-400'
    return 'border-gray-200'
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-blue-900">FINDIR</h1>
          <p className="text-gray-500 mt-2">Financial Director</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          <h2 className="text-xl font-semibold text-gray-800 mb-6">Регистрация</h2>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Название компании */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Название компании</label>
              <input
                type="text"
                value={form.company_name}
                onChange={e => setForm({ ...form, company_name: e.target.value })}
                placeholder="ООО Моя Компания"
                className={ic}
                required
              />
            </div>

            {/* Домен */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Домен организации
              </label>
              <div className="flex items-center border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 transition-all"
                   style={{ borderColor: domainStatus === 'ok' ? '#4ade80' : domainStatus === 'taken' ? '#f87171' : '#e5e7eb' }}>
                <input
                  type="text"
                  value={form.domain}
                  onChange={e => handleDomainChange(e.target.value)}
                  placeholder="ooo-moya-kompaniya"
                  className="flex-1 px-4 py-2.5 text-sm focus:outline-none font-mono"
                  required
                  minLength={3}
                />
                <span className="px-3 py-2.5 bg-gray-50 border-l border-gray-200 text-xs text-gray-400 whitespace-nowrap">
                  .{BASE_DOMAIN}
                </span>
              </div>

              {/* Статус домена */}
              <div className="mt-1 min-h-[18px]">
                {domainStatus === 'checking' && (
                  <p className="text-xs text-gray-400">Проверяем доступность...</p>
                )}
                {domainStatus === 'ok' && form.domain && (
                  <p className="text-xs text-green-600">
                    ✓ Домен свободен — <span className="font-mono">{form.domain}.{BASE_DOMAIN}</span>
                  </p>
                )}
                {domainStatus === 'taken' && (
                  <p className="text-xs text-red-600">✗ Этот домен уже занят</p>
                )}
                {domainStatus === 'error' && (
                  <p className="text-xs text-amber-600">Минимум 3 символа (латиница, цифры, дефис)</p>
                )}
                {!domainStatus && !form.domain && form.company_name && (
                  <p className="text-xs text-gray-400">Генерируем домен...</p>
                )}
              </div>
            </div>

            {/* Имя */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ваше имя</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="Иван Иванов"
                className={ic}
                required
              />
            </div>

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                placeholder="ivan@company.com"
                className={ic}
                required
              />
            </div>

            {/* Пароль */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Пароль</label>
              <input
                type="password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                placeholder="минимум 8 символов"
                className={ic}
                required
              />
            </div>

            {/* Подтверждение */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Подтвердите пароль</label>
              <input
                type="password"
                value={form.password_confirmation}
                onChange={e => setForm({ ...form, password_confirmation: e.target.value })}
                placeholder="повторите пароль"
                className={ic}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || domainStatus === 'taken' || domainStatus === 'checking'}
              className="w-full bg-blue-900 text-white py-2.5 rounded-lg font-medium hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Регистрация...' : 'Зарегистрироваться'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-6">
            Уже есть аккаунт?{' '}
            <Link to="/login" className="text-blue-600 hover:underline font-medium">Войти</Link>
          </p>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">
          14 дней бесплатно • Без привязки карты
        </p>
      </div>
    </div>
  )
}
