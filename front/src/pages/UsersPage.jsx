import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import { SkeletonRows } from '../components/Busy'
import {
  getUsers, createUser, updateUser, setUserPassword, deleteUser, getRoles, changeMyPassword,
} from '../api/users'

/**
 * Сотрудники компании.
 *
 * Пароль задаёт администратор и передаёт человеку — почта не настроена, и
 * приглашение письмом сейчас никуда бы не ушло. Свой пароль сотрудник меняет
 * здесь же, в блоке «Мой доступ».
 *
 * Уволенных выключают, а не удаляют: их документы остаются в учёте, и автор
 * должен читаться.
 */

const ic  = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const lbl = 'block text-xs font-medium text-gray-500 mb-1'

const fmtDate = (s) => {
  if (!s) return 'ни разу'
  const d = new Date(String(s).replace(' ', 'T'))
  return isNaN(d) ? s : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const EMPTY = { name: '', email: '', password: '', role_id: '' }

export default function UsersPage() {
  const [users, setUsers] = useState(null)
  const [roles, setRoles] = useState([])
  const [me, setMe]       = useState(null)
  const [form, setForm]   = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  // Смена собственного пароля
  const [pwd, setPwd] = useState({ current: '', next: '' })

  const load = () => getUsers().then(r => { setUsers(r.data.data || []); setMe(r.data.me) })

  useEffect(() => {
    load().catch(e => setError(e.response?.data?.message || 'Не удалось получить список'))
    getRoles().then(r => setRoles(r.data.data || [])).catch(() => {})
  }, [])

  const say = (msg) => { setNotice(msg); setError(''); setTimeout(() => setNotice(''), 4000) }
  const fail = (e, fallback) => setError(e.response?.data?.message || fallback)

  const save = async () => {
    if (!form.name.trim() || !form.email.trim()) return setError('Имя и почта обязательны')
    if (!form.id && form.password.length < 8) return setError('Пароль — не короче 8 символов')
    if (!form.role_id) return setError('Выберите должность')

    setSaving(true); setError('')
    try {
      if (form.id) await updateUser(form.id, { name: form.name, email: form.email, role_id: form.role_id })
      else         await createUser(form)
      setForm(null)
      await load()
      say(form.id ? 'Сохранено' : 'Сотрудник заведён — передайте ему пароль')
    } catch (e) { fail(e, 'Не удалось сохранить') } finally { setSaving(false) }
  }

  const toggleActive = async (u) => {
    try {
      await updateUser(u.id, { is_active: !u.is_active })
      await load()
      say(u.is_active ? 'Доступ отключён' : 'Доступ включён')
    } catch (e) { fail(e, 'Не удалось изменить') }
  }

  const resetPassword = async (u) => {
    const password = prompt(`Новый пароль для «${u.name}» (не короче 8 символов):`)
    if (!password) return
    try {
      await setUserPassword(u.id, password)
      say('Пароль изменён — передайте его сотруднику')
    } catch (e) { fail(e, 'Не удалось сменить пароль') }
  }

  const remove = async (u) => {
    if (!confirm(`Удалить сотрудника «${u.name}»? Обычно достаточно выключить доступ.`)) return
    try {
      await deleteUser(u.id)
      await load()
      say('Сотрудник удалён')
    } catch (e) { fail(e, 'Не удалось удалить') }
  }

  const changeOwnPassword = async () => {
    if (pwd.next.length < 8) return setError('Новый пароль — не короче 8 символов')
    try {
      await changeMyPassword(pwd.current, pwd.next)
      setPwd({ current: '', next: '' })
      say('Пароль изменён. Другие ваши сессии завершены.')
    } catch (e) {
      const errs = e.response?.data?.errors
      setError(errs ? Object.values(errs).flat().join(', ') : (e.response?.data?.message || 'Не удалось сменить пароль'))
    }
  }

  return (
    <Layout>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Сотрудники</h1>
          <p className="text-sm text-gray-500 mt-1">
            Кто имеет доступ к компании и что каждому позволено. Набор прав задаётся должностью.
          </p>
        </div>
        <button onClick={() => { setForm({ ...EMPTY, role_id: roles[0]?.id || '' }); setError('') }}
          className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800">
          + Добавить сотрудника
        </button>
      </div>

      {error &&  <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{error}</div>}
      {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3 mb-4">{notice}</div>}

      {form && (
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 mb-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className={lbl}>Имя</label>
              <input className={ic} value={form.name} autoFocus
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Мария" />
            </div>
            <div>
              <label className={lbl}>Почта — она же логин</label>
              <input className={ic} value={form.email} type="email"
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="maria@example.com" />
            </div>
            <div>
              <label className={lbl}>Должность</label>
              <select className={ic} value={form.role_id}
                onChange={e => setForm(f => ({ ...f, role_id: Number(e.target.value) }))}>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            {!form.id && (
              <div>
                <label className={lbl}>Пароль</label>
                <input className={ic} value={form.password} type="text"
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="не короче 8 символов" />
                <p className="text-[11px] text-gray-400 mt-1">Передайте сотруднику — он сменит его сам</p>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving}
              className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            <button onClick={() => setForm(null)}
              className="px-4 py-2 border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50">
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mb-6">
        {users === null ? (
          <div className="p-4"><SkeletonRows rows={3} /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-5 py-2">Сотрудник</th>
                <th className="text-left px-5 py-2">Должность</th>
                <th className="text-left px-5 py-2">Последний вход</th>
                <th className="text-left px-5 py-2">Доступ</th>
                <th className="px-5 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className={`border-b border-gray-50 last:border-0 ${u.is_active ? '' : 'opacity-50'}`}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-gray-800">
                      {u.name}
                      {u.id === me && <span className="ml-2 text-[11px] text-blue-600">это вы</span>}
                    </div>
                    <div className="text-xs text-gray-400">{u.email}</div>
                  </td>
                  <td className="px-5 py-3 text-gray-700">{u.role_name || <span className="text-red-500">не назначена</span>}</td>
                  <td className="px-5 py-3 text-xs text-gray-500">{fmtDate(u.last_login_at)}</td>
                  <td className="px-5 py-3">
                    <button onClick={() => toggleActive(u)}
                      className={`text-xs px-2 py-1 rounded-full ${u.is_active
                        ? 'bg-green-50 text-green-700 hover:bg-green-100'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                      {u.is_active ? 'включён' : 'выключен'}
                    </button>
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <button onClick={() => { setForm({ id: u.id, name: u.name, email: u.email, role_id: u.role_id, password: '' }); setError('') }}
                      className="text-xs text-blue-600 hover:text-blue-800 mr-3">Изменить</button>
                    <button onClick={() => resetPassword(u)}
                      className="text-xs text-gray-500 hover:text-gray-700 mr-3">Сменить пароль</button>
                    {u.id !== me && (
                      <button onClick={() => remove(u)} className="text-xs text-red-400 hover:text-red-600">Удалить</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Свой пароль меняет сам сотрудник: выданный администратором иначе
          останется у него навсегда */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 max-w-xl">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Мой доступ</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Текущий пароль</label>
            <input className={ic} type="password" value={pwd.current}
              onChange={e => setPwd(p => ({ ...p, current: e.target.value }))} />
          </div>
          <div>
            <label className={lbl}>Новый пароль</label>
            <input className={ic} type="password" value={pwd.next}
              onChange={e => setPwd(p => ({ ...p, next: e.target.value }))} placeholder="не короче 8 символов" />
          </div>
        </div>
        <button onClick={changeOwnPassword} disabled={!pwd.current || !pwd.next}
          className="mt-3 px-4 py-2 border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40">
          Сменить пароль
        </button>
        <p className="text-[11px] text-gray-400 mt-2">Остальные ваши сессии будут завершены</p>
      </div>
    </Layout>
  )
}
