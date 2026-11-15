import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../api/client'
import { rememberAccount } from '../utils/accounts'
import { Check, X } from 'lucide-react'
import AuthShell, { AuthField, PasswordInput, authInput } from '../components/AuthShell'
import { Button } from '../components/ui'

// Допустим домен из одного символа: «a» → findir_a.
// Дефис разрешён только внутри — не в начале и не в конце.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

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
      if (!DOMAIN_RE.test(slug)) return
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
    if (!clean || !DOMAIN_RE.test(clean)) { setDomainStatus(clean ? 'error' : null); return }

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
    if (!form.domain || !DOMAIN_RE.test(form.domain)) { setError('Укажите корректный домен'); return }

    setLoading(true)
    try {
      const res = await api.post('/register', form)
      // Новая компания встаёт в общий список: финдиректор мог заводить её,
      // уже работая с другими клиентами
      rememberAccount(res.data)
      navigate('/dashboard')
    } catch (err) {
      const errors = err.response?.data?.errors
      if (errors) setError(Object.values(errors).flat().join(', '))
      else setError(err.response?.data?.message || 'Ошибка регистрации')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell title="Регистрация компании" subtitle="14 дней бесплатно, карта не нужна"
      footer={<>Уже есть аккаунт?{' '}
        <Link to="/login" className="font-medium text-brand-700 hover:text-brand-900 hover:underline">Войти</Link></>}>
      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthField label="Название компании">
          <input
            type="text"
            value={form.company_name}
            onChange={e => setForm({ ...form, company_name: e.target.value })}
            placeholder="ООО Моя Компания"
            className={authInput}
            autoFocus
            required
          />
        </AuthField>

        <AuthField label="Домен организации">
          <div className={`flex items-center h-11 border rounded-lg overflow-hidden transition-[border-color,box-shadow]
                           focus-within:ring-2 focus-within:ring-brand-500/25 ${
            domainStatus === 'ok' ? 'border-emerald-400'
              : domainStatus === 'taken' ? 'border-red-400'
              : domainStatus === 'error' ? 'border-amber-400'
              : 'border-gray-200 focus-within:border-brand-500'}`}>
            <input
              type="text"
              value={form.domain}
              onChange={e => handleDomainChange(e.target.value)}
              placeholder="ooo-moya-kompaniya"
              className="flex-1 min-w-0 h-full px-3.5 text-sm focus:outline-none font-mono"
              required
              minLength={1}
              pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
              title="Латиница, цифры и дефис; дефис не в начале и не в конце"
            />
            <span className="h-full flex items-center px-3 bg-gray-50 border-l border-gray-200 text-xs text-gray-500 whitespace-nowrap">
              .{BASE_DOMAIN}
            </span>
          </div>

          {/* Статус домена. Высота держится и когда строки нет: иначе форма
              дёргается на каждой проверке */}
          <div className="mt-1.5 min-h-[18px] text-xs">
            {domainStatus === 'checking' && <p className="text-gray-500">Проверяем доступность…</p>}
            {domainStatus === 'ok' && form.domain && (
              <p className="text-emerald-700 flex items-center gap-1">
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                Домен свободен — <span className="font-mono">{form.domain}.{BASE_DOMAIN}</span>
              </p>
            )}
            {domainStatus === 'taken' && (
              <p className="text-red-600 flex items-center gap-1"><X className="w-3.5 h-3.5" aria-hidden="true" /> Этот домен уже занят</p>
            )}
            {domainStatus === 'error' && (
              <p className="text-amber-700">Латиница, цифры и дефис; дефис не в начале и не в конце</p>
            )}
            {!domainStatus && !form.domain && form.company_name && <p className="text-gray-500">Подбираем домен…</p>}
          </div>
        </AuthField>

        <AuthField label="Ваше имя">
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Иван Иванов"
            autoComplete="name"
            className={authInput}
            required
          />
        </AuthField>

        <AuthField label="Email">
          <input
            type="email"
            value={form.email}
            onChange={e => setForm({ ...form, email: e.target.value })}
            placeholder="ivan@company.com"
            autoComplete="username"
            className={authInput}
            required
          />
        </AuthField>

        <div className="grid sm:grid-cols-2 gap-4">
          <AuthField label="Пароль">
            <PasswordInput
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              placeholder="от 8 символов"
              autoComplete="new-password"
              required
            />
          </AuthField>

          <AuthField label="Ещё раз">
            <PasswordInput
              value={form.password_confirmation}
              onChange={e => setForm({ ...form, password_confirmation: e.target.value })}
              autoComplete="new-password"
              required
            />
          </AuthField>
        </div>

        <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full mt-2"
          disabled={domainStatus === 'taken' || domainStatus === 'checking'}>
          Зарегистрироваться
        </Button>
      </form>
    </AuthShell>
  )
}
