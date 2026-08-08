import { useState, useRef, useEffect } from 'react'
import api from '../api/client'
import {
  listAccounts, activeTenantId, activateAccount, rememberAccount, forgetAccount,
} from '../utils/accounts'
import { tenantColors, tenantColor, FALLBACK } from '../utils/tenantColor'

/**
 * Плашка с названием компании — она же переключатель баз.
 *
 * Имя компании здесь главный ориентир: в одном браузере легко перепутать
 * клиентов и внести операцию не туда. Поэтому плашка заметная, а переключение
 * живёт прямо в ней, а не в настройках.
 *
 * После смены компании перезагружаем страницу целиком. Половина экранов держит
 * загруженные данные в своём состоянии, и мягкое переключение оставило бы на
 * виду цифры прошлого клиента — ровно ту ошибку, от которой всё это затевалось.
 */
export default function TenantSwitcher() {
  const [open, setOpen]   = useState(false)
  const [adding, setAdding] = useState(false)
  const [accounts, setAccounts] = useState(listAccounts)
  const boxRef = useRef(null)

  const activeId = activeTenantId()
  const active   = accounts.find(a => a.tenant?.id === activeId)?.tenant
                || (() => { try { return JSON.parse(localStorage.getItem('tenant') || '{}') } catch { return {} } })()

  // Цвета считаем на весь список разом — так соседние компании гарантированно
  // разного тона, а плашка и строка в списке показывают один и тот же цвет
  const colors = tenantColors(accounts.map(a => a.tenant?.id).filter(Boolean))
  const tone   = colors.get(activeId) || tenantColor(activeId) || FALLBACK

  useEffect(() => {
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setAdding(false) }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const switchTo = (id) => {
    if (id === activeId) { setOpen(false); return }
    if (activateAccount(id)) window.location.assign('/dashboard')
  }

  const disconnect = async (acc, e) => {
    e.stopPropagation()
    if (!confirm(`Отключить «${acc.tenant.name}»? Данные останутся на месте, потребуется войти заново.`)) return

    // Гасим токен на сервере от имени этой компании, не переключая активную:
    // иначе он остался бы жить до истечения срока
    try {
      await api.post('/logout', {}, { headers: { Authorization: `Bearer ${acc.token}` } })
    } catch { /* уже недействителен — из списка всё равно убираем */ }

    const left = forgetAccount(acc.tenant.id)
    if (acc.tenant.id === activeId) window.location.assign(left.length ? '/dashboard' : '/login')
    else setAccounts(left)
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => { setAccounts(listAccounts()); setOpen(!open); setAdding(false) }}
        title="Текущая база — нажмите, чтобы переключиться"
        style={{ backgroundColor: tone.bg }}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-white
                   text-base font-bold leading-none whitespace-nowrap
                   hover:brightness-125 transition-[filter]"
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tone.dot }} />
        {active?.name || 'Компания'}
        <span className="text-[10px] font-normal opacity-70">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-gray-400">
            Мои компании
          </div>

          {accounts.map(acc => {
            const c        = colors.get(acc.tenant.id) || FALLBACK
            const isActive = acc.tenant.id === activeId
            return (
            <div
              key={acc.tenant.id}
              onClick={() => switchTo(acc.tenant.id)}
              // Активную отмечаем полосой в её же тоне, а не заливкой: заливка
              // спорила бы с цветом самой компании
              style={isActive ? { boxShadow: `inset 3px 0 0 ${c.bg}` } : undefined}
              className={
                'group flex items-center gap-2 px-3 py-2 cursor-pointer ' +
                (isActive ? 'bg-gray-50' : 'hover:bg-gray-50')
              }
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: c.bg, opacity: isActive ? 1 : 0.55 }} />
              <div className="min-w-0 flex-1">
                <div className={
                  'text-sm truncate ' + (isActive ? 'font-semibold text-gray-900' : 'text-gray-700')
                }>
                  {acc.tenant.name}
                </div>
                <div className="text-[11px] text-gray-400 truncate">
                  {acc.tenant.id}{acc.user?.email ? ` · ${acc.user.email}` : ''}
                </div>
              </div>
              <button
                onClick={(e) => disconnect(acc, e)}
                title="Отключить"
                className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-600 px-1 transition"
              >
                ×
              </button>
            </div>
            )
          })}

          {!adding ? (
            <button
              onClick={() => setAdding(true)}
              className="block w-full text-left px-3 py-2 mt-1 border-t border-gray-100
                         text-sm text-blue-700 hover:bg-blue-50 font-medium"
            >
              + Добавить компанию
            </button>
          ) : (
            <AddAccountForm
              onDone={(book) => { setAccounts(book); window.location.assign('/dashboard') }}
              onCancel={() => setAdding(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Вход во вторую компанию, не выходя из текущей. */
function AddAccountForm({ onDone, onCancel }) {
  const [form, setForm]   = useState({ tenant_id: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy]   = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res = await api.post('/login', form)
      onDone(rememberAccount(res.data))
    } catch (err) {
      const d = err.response?.data
      setError(d?.errors?.email?.[0] || d?.errors?.tenant_id?.[0] || d?.message || 'Не удалось войти')
    } finally { setBusy(false) }
  }

  const ic = 'w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <form onSubmit={submit} className="px-3 py-2.5 mt-1 border-t border-gray-100 space-y-2">
      {error && <div className="text-[11px] text-red-600">{error}</div>}
      <input
        value={form.tenant_id}
        onChange={e => setForm({ ...form, tenant_id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
        placeholder="домен компании"
        className={`${ic} font-mono`}
        autoFocus required
      />
      <input
        type="email" value={form.email}
        onChange={e => setForm({ ...form, email: e.target.value })}
        placeholder="email" className={ic} required
      />
      <input
        type="password" value={form.password}
        onChange={e => setForm({ ...form, password: e.target.value })}
        placeholder="пароль" className={ic} required
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy}
          className="flex-1 px-3 py-1.5 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
          {busy ? 'Вход...' : 'Подключить'}
        </button>
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
          Отмена
        </button>
      </div>
    </form>
  )
}
