import { useEffect, useState } from 'react'
import { getProjects } from '../api/projects'
import { getBalanceItemsList } from '../api/balanceItems'
import { getInfo } from '../api/info'
import { getRemoteDictionaries } from '../api/integrations'

/**
 * Форма настроек интеграции, собранная по схеме с сервера.
 *
 * Поля описаны в IntegrationRegistry, а не здесь: пока форма была бы своя у
 * каждой системы, «интеграций может быть несколько» упиралось бы в вёрстку.
 */

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

export default function IntegrationSettingsForm({ schema, values, onChange, integrationId, credentials, onCredentials }) {
  const [projects, setProjects] = useState([])
  const [accounts, setAccounts] = useState([])
  const [infos, setInfos]       = useState({})     // тип справочника → список
  const [remote, setRemote]     = useState(null)   // справочники внешней системы
  const [remoteError, setRemoteError] = useState('')
  const [loadingRemote, setLoadingRemote] = useState(false)

  useEffect(() => {
    getProjects().then(r => setProjects(r.data.data || r.data || [])).catch(() => {})
    getBalanceItemsList().then(r => setAccounts(r.data.data || r.data || [])).catch(() => {})

    const types = [...new Set((schema.settings || [])
      .filter(f => f.kind === 'info').map(f => f.info_type))]

    types.forEach(t => {
      getInfo({ type: t })
        .then(r => setInfos(prev => ({ ...prev, [t]: r.data.data || [] })))
        .catch(() => {})
    })
  }, [schema])

  // Склады и юрлица тянем только по кнопке: это обращение к чужому серверу,
  // и делать его при каждом открытии формы незачем
  const loadRemote = () => {
    setLoadingRemote(true); setRemoteError('')
    getRemoteDictionaries(integrationId)
      .then(r => setRemote(r.data.data || {}))
      .catch(e => setRemoteError(e.response?.data?.message || 'Не удалось получить справочники'))
      .finally(() => setLoadingRemote(false))
  }

  const set = (key, value) => onChange({ ...values, [key]: value })

  const renderField = (f) => {
    const v = values?.[f.key]

    switch (f.kind) {
      case 'checkbox':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-blue-900"
                   checked={!!v} onChange={e => set(f.key, e.target.checked)} />
            <span className="text-sm text-gray-700">{f.label}</span>
          </label>
        )

      case 'select':
        return (
          <select className={inputCls} value={v ?? ''} onChange={e => set(f.key, e.target.value)}>
            {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )

      case 'project':
        return (
          <select className={inputCls} value={v ?? ''} onChange={e => set(f.key, e.target.value || null)}>
            <option value="">— выберите —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )

      case 'balance_item': {
        const allowed = f.codes
          ? accounts.filter(a => f.codes.includes(a.code))
          : accounts
        return (
          <select className={inputCls} value={v ?? ''} onChange={e => set(f.key, e.target.value || null)}>
            <option value="">— выберите —</option>
            {allowed.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        )
      }

      case 'info': {
        const list = infos[f.info_type] || []
        return (
          <select className={inputCls} value={v ?? ''} onChange={e => set(f.key, e.target.value || null)}>
            <option value="">— выберите —</option>
            {list.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )
      }

      case 'remote_multi': {
        const list = remote?.[f.source]
        const selected = Array.isArray(v) ? v.map(String) : []

        if (!list) {
          return (
            <div className="text-xs text-gray-500">
              {selected.length > 0 && <div className="mb-1">Выбрано: {selected.join(', ')}</div>}
              {integrationId
                ? <button type="button" onClick={loadRemote} disabled={loadingRemote}
                    className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                    {loadingRemote ? 'Запрашиваю...' : 'Показать список'}
                  </button>
                : <span>Доступно после сохранения и проверки связи</span>}
              {remoteError && <div className="text-red-600 mt-1">{remoteError}</div>}
            </div>
          )
        }

        return (
          <div className="border border-gray-200 rounded-lg max-h-40 overflow-y-auto p-2 space-y-1">
            {list.length === 0 && <div className="text-xs text-gray-400">Пусто</div>}
            {list.map(o => (
              <label key={o.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-blue-900"
                  checked={selected.includes(String(o.id))}
                  onChange={e => {
                    const next = e.target.checked
                      ? [...selected, String(o.id)]
                      : selected.filter(x => x !== String(o.id))
                    set(f.key, next)
                  }} />
                <span className="text-gray-700">{o.name}</span>
              </label>
            ))}
          </div>
        )
      }

      case 'password':
        return (
          <input type="password" className={inputCls}
            value={credentials?.[f.key] ?? ''}
            placeholder={values?.__has_credentials ? 'задан — оставьте пустым, чтобы не менять' : ''}
            onChange={e => onCredentials({ ...credentials, [f.key]: e.target.value })} />
        )

      default:
        return (
          <input type="text" className={inputCls}
            value={(f.__credential ? credentials?.[f.key] : v) ?? ''}
            onChange={e => f.__credential
              ? onCredentials({ ...credentials, [f.key]: e.target.value })
              : set(f.key, e.target.value)} />
        )
    }
  }

  const block = (title, fields) => (
    <div className="space-y-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{title}</div>
      {fields.map(f => (
        <div key={f.key}>
          {f.kind !== 'checkbox' && (
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {f.label}{f.required && <span className="text-red-500"> *</span>}
            </label>
          )}
          {renderField(f)}
          {f.hint && <p className="text-[11px] text-gray-400 mt-1">{f.hint}</p>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {block('Доступ', (schema.credentials || []).map(f => ({ ...f, __credential: true })))}
      {block('Правила переноса', schema.settings || [])}
    </div>
  )
}
