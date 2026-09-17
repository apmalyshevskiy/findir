import { useCallback, useEffect, useState } from 'react'
import { getProjects } from '../api/projects'
import { getBalanceItemsList } from '../api/balanceItems'
import { getInfo } from '../api/info'
import { getRemoteDictionaries } from '../api/integrations'

/**
 * Форма настроек интеграции, собранная по схеме с сервера.
 *
 * Поля описаны в IntegrationRegistry, а не здесь: пока форма была бы своя у
 * каждой системы, «интеграций может быть несколько» упиралось бы в вёрстку.
 *
 * Кроме отдельных полей схема умеет таблицу (`remote_table`): строки берутся
 * из справочника внешней системы, колонки описаны в схеме. Так настраиваются
 * вещи, которые различаются по точкам заведения, — у каждой своя статья
 * дохода, своя касса, свой эквайер.
 */

const inputCls = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const cellCls  = 'w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

export default function IntegrationSettingsForm({ schema, values, onChange, integrationId, credentials, onCredentials }) {
  const [projects, setProjects] = useState([])
  const [accounts, setAccounts] = useState([])
  const [infos, setInfos]       = useState({})     // тип справочника → список
  const [remote, setRemote]     = useState(null)   // справочники внешней системы
  const [remoteError, setRemoteError] = useState('')
  const [loadingRemote, setLoadingRemote] = useState(false)

  /**
   * Список справочника по требованию.
   *
   * Типы, нужные колонкам таблиц, заранее неизвестны: они зависят от счёта,
   * выбранного в строке. Поэтому не один заход при открытии, а по мере того,
   * как тип понадобился.
   */
  const ensureInfo = useCallback((type) => {
    if (!type) return
    setInfos(prev => {
      if (prev[type]) return prev
      getInfo({ type })
        .then(r => setInfos(p => ({ ...p, [type]: r.data.data || [] })))
        .catch(() => {})
      return { ...prev, [type]: [] }     // занимаем место, чтобы не запросить дважды
    })
  }, [])

  useEffect(() => {
    getProjects().then(r => setProjects(r.data.data || r.data || [])).catch(() => {})
    getBalanceItemsList().then(r => setAccounts(r.data.data || r.data || [])).catch(() => {})

    const fields = schema.settings || []
    const types = [
      ...fields.filter(f => f.kind === 'info').map(f => f.info_type),
      ...fields.flatMap(f => (f.columns || []).filter(c => c.kind === 'info').map(c => c.info_type)),
    ]

    ;[...new Set(types)].forEach(ensureInfo)
  }, [schema, ensureInfo])

  /**
   * Справочники для колонок, чей тип зависит от выбранного в строке счёта.
   *
   * Догружаем эффектом, а не при отрисовке: менять состояние по ходу
   * отрисовки React не разрешает, да и незачем — счёт уже выбран и лежит в
   * значениях.
   */
  useEffect(() => {
    const need = new Set()

    for (const f of schema.settings || []) {
      for (const c of f.columns || []) {
        if (c.kind !== 'info_of_account') continue

        for (const row of Object.values(values?.[f.key] || {})) {
          const type = accounts.find(a => String(a.id) === String(row?.[c.account]))?.info_1_type
          if (type) need.add(type)
        }
      }
    }

    need.forEach(ensureInfo)
  }, [schema, values, accounts, ensureInfo])

  // Справочники кассы тянем только по кнопке: это обращение к чужому серверу,
  // и делать его при каждом открытии формы незачем
  const loadRemote = () => {
    setLoadingRemote(true); setRemoteError('')
    getRemoteDictionaries(integrationId)
      .then(r => setRemote(r.data.data || {}))
      .catch(e => setRemoteError(e.response?.data?.message || 'Не удалось получить справочники'))
      .finally(() => setLoadingRemote(false))
  }

  const set = (key, value) => onChange({ ...values, [key]: value })

  const accountById = (id) => accounts.find(a => String(a.id) === String(id))

  /** Выпадающий список счетов; codes — подсказка допустимых */
  const accountSelect = (value, onPick, codes, cls) => {
    const allowed = codes ? accounts.filter(a => codes.includes(a.code)) : accounts
    return (
      <select className={cls} value={value ?? ''} onChange={e => onPick(e.target.value || null)}>
        <option value="">— выберите —</option>
        {allowed.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
      </select>
    )
  }

  const infoSelect = (value, onPick, type, cls) => (
    <select className={cls} value={value ?? ''} onChange={e => onPick(e.target.value || null)}
            disabled={!type}>
      <option value="">{type ? '— выберите —' : '— сначала счёт —'}</option>
      {(infos[type] || []).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
    </select>
  )

  /** Кнопка «показать список» вместо справочника, пока его не запросили */
  const remotePlaceholder = (hintWhenEmpty) => (
    <div className="text-xs text-gray-500">
      {integrationId
        ? <button type="button" onClick={loadRemote} disabled={loadingRemote}
            className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
            {loadingRemote ? 'Запрашиваю...' : 'Показать список'}
          </button>
        : <span>{hintWhenEmpty}</span>}
      {remoteError && <div className="text-red-600 mt-1">{remoteError}</div>}
    </div>
  )

  /** Таблица настроек: строка — объект внешней системы, колонки из схемы */
  const renderTable = (f) => {
    const rows = remote?.[f.source]
    const map  = values?.[f.key] || {}
    const filled = Object.keys(map).length

    if (!rows) {
      return (
        <div>
          {filled > 0 && <div className="text-xs text-gray-500 mb-1">Заполнено строк: {filled}</div>}
          {remotePlaceholder('Доступно после сохранения и проверки связи')}
        </div>
      )
    }

    const setCell = (rowId, colKey, value) => set(f.key, {
      ...map,
      [rowId]: { ...(map[rowId] || {}), [colKey]: value },
    })

    return (
      <div className="overflow-x-auto border border-gray-100 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr className="text-left">
              <th className="py-2 px-3 font-medium whitespace-nowrap">{f.row_label || 'Строка'}</th>
              {f.columns.map(c => <th key={c.key} className="py-2 px-3 font-medium">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td className="py-2 px-3 text-gray-400" colSpan={f.columns.length + 1}>Пусто</td></tr>
            )}
            {rows.map(row => {
              const cur = map[String(row.id)] || {}

              return (
                <tr key={row.id} className="border-t border-gray-50 align-top">
                  <td className="py-1.5 px-3 text-gray-700 whitespace-nowrap">{row.name}</td>
                  {f.columns.map(c => {
                    const pick = (v) => setCell(String(row.id), c.key, v)

                    if (c.kind === 'balance_item') {
                      return <td key={c.key} className="py-1.5 px-3 min-w-[13rem]">
                        {accountSelect(cur[c.key], pick, c.codes, cellCls)}
                      </td>
                    }

                    if (c.kind === 'info_of_account') {
                      // Какой справочник подставлять, решает счёт этой же
                      // строки: у кассы это кассы, у клиентов — контрагенты.
                      // Сам список догружает эффект выше
                      const type = accountById(cur[c.account])?.info_1_type
                      return <td key={c.key} className="py-1.5 px-3 min-w-[13rem]">
                        {infoSelect(cur[c.key], pick, type, cellCls)}
                      </td>
                    }

                    return <td key={c.key} className="py-1.5 px-3 min-w-[13rem]">
                      {infoSelect(cur[c.key], pick, c.info_type, cellCls)}
                    </td>
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

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

      case 'balance_item':
        return accountSelect(v, (x) => set(f.key, x), f.codes, inputCls)

      case 'info':
        return infoSelect(v, (x) => set(f.key, x), f.info_type, inputCls)

      case 'remote_table':
        return renderTable(f)

      case 'remote_multi': {
        const list = remote?.[f.source]
        const selected = Array.isArray(v) ? v.map(String) : []

        if (!list) {
          return (
            <div>
              {selected.length > 0 && <div className="text-xs text-gray-500 mb-1">Выбрано: {selected.join(', ')}</div>}
              {remotePlaceholder('Доступно после сохранения и проверки связи')}
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

  const field = (f) => (
    <div key={f.key}>
      {f.kind !== 'checkbox' && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {f.label}{f.required && <span className="text-red-500"> *</span>}
        </label>
      )}
      {renderField(f)}
      {f.hint && <p className="text-[11px] text-gray-400 mt-1">{f.hint}</p>}
    </div>
  )

  const block = (title, fields) => (
    <div className="space-y-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{title}</div>
      {fields.map(field)}
    </div>
  )

  const settings = schema.settings || []

  // Таблицы выносим под колонки: в половину ширины они не помещаются
  const plain  = settings.filter(f => f.kind !== 'remote_table')
  const tables = settings.filter(f => f.kind === 'remote_table')

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        {block('Доступ', (schema.credentials || []).map(f => ({ ...f, __credential: true })))}
        {block('Правила переноса', plain)}
      </div>

      {tables.length > 0 && (
        <div className="space-y-5">
          {tables.map(field)}
        </div>
      )}
    </div>
  )
}
