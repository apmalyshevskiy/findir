import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../api/client'
import { rememberAccount } from '../utils/accounts'
import AuthShell, { AuthField, PasswordInput, authInput } from '../components/AuthShell'
import { Button } from '../components/ui'

export default function LoginPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ email: '', password: '', tenant_id: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await api.post('/login', form)
      // Не затираем уже подключённые компании: вход добавляет ещё одну и
      // делает её активной
      rememberAccount(res.data)
      navigate('/dashboard')
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell title="Вход в систему" subtitle="Домен организации вы задали при регистрации"
      footer={<>Нет аккаунта?{' '}
        <Link to="/register" className="font-medium text-brand-700 hover:text-brand-900 hover:underline">Зарегистрироваться</Link></>}>
      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthField label="Домен организации" hint="Латиница, цифры, дефис">
          <input
            type="text"
            value={form.tenant_id}
            onChange={e => setForm({ ...form, tenant_id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
            placeholder="ooo-moya-kompaniya"
            className={`${authInput} font-mono`}
            autoFocus
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

        <AuthField label="Пароль">
          <PasswordInput
            value={form.password}
            onChange={e => setForm({ ...form, password: e.target.value })}
            autoComplete="current-password"
            required
          />
        </AuthField>

        <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full mt-2">
          Войти
        </Button>
      </form>
    </AuthShell>
  )
}
