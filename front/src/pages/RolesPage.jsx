import { useEffect, useMemo, useState } from 'react'
import Layout from '../components/Layout'
import { SkeletonRows } from '../components/Busy'
import { getRoles, createRole, updateRole, deleteRole } from '../api/users'
import { getBalanceItemsList } from '../api/balanceItems'

/**
 * Должности — наборы прав по разделам.
 *
 * Матрица «раздел × уровень» вместо списка галочек: так видно всю должность
 * целиком и понятно, чем «Кассир» отличается от «Бухгалтера».
 *
 * У администратора права не редактируются: урезав их, компанию можно закрыть
 * от самой себя — вместе с этой же страницей.
 */

const ic = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

const LEVEL_STYLE = {
  none: 'bg-gray-100 text-gray-500',
  view: 'bg-blue-50 text-blue-700',
  edit: 'bg-green-50 text-green-700',
}

/**
 * Дерево плана счетов с галочками «закрыть».
 *
 * Отмеченный счёт закрывается вместе со всем поддеревом — так же считает
 * сервер. Поэтому потомки закрытой группы показываются погашенными: галочка на
 * них ничего не изменит, а видеть, что они тоже закрыты, нужно.
 */
function AccountTree({ items, denied, onToggle }) {
  const byParent = useMemo(() => {
    const map = {}
    items.forEach(i => { (map[i.parent_id ?? 0] ||= []).push(i) })
    Object.values(map).forEach(list => list.sort((a, b) => a.code.localeCompare(b.code)))
    return map
  }, [items])

  const render = (parentId, depth, inheritedClosed) => (byParent[parentId] || []).map(item => {
    const own    = denied.has(item.id)
    const closed = own || inheritedClosed

    return (
      <div key={item.id}>
        <label className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 ${
          closed ? 'text-gray-400' : 'text-gray-700'}`}
          style={{ paddingLeft: 12 + depth * 18 }}>
          <input type="checkbox" className="rounded" checked={closed} disabled={inheritedClosed}
            onChange={() => onToggle(item.id)} />
          <span className="font-mono text-xs text-gray-500 w-16 flex-shrink-0">{item.code}</span>
          <span className="truncate">{item.name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
          {inheritedClosed && !own && (
            <span className="text-[10px] text-gray-400 flex-shrink-0">закрыт вместе с группой</span>
          )}
        </label>
        {render(item.id, depth + 1, closed)}
      </div>
    )
  })

  return <div className="max-h-80 overflow-y-auto">{render(0, 0, false)}</div>
}

export default function RolesPage() {
  const [roles, setRoles]       = useState(null)
  const [sections, setSections] = useState({})
  const [levels, setLevels]     = useState({})
  const [form, setForm]         = useState(null)
  const [error, setError]       = useState('')
  const [notice, setNotice]     = useState('')
  const [saving, setSaving]     = useState(false)
  const [accounts, setAccounts] = useState([])
  const [showAccounts, setShowAccounts] = useState(false)
  // Разделы, где «изменение» вообще что-то даёт, и подсказки к неочевидным
  const [editable, setEditable] = useState([])
  const [hints, setHints]       = useState({})

  const load = () => getRoles().then(r => {
    setRoles(r.data.data || [])
    setSections(r.data.sections || {})
    setLevels(r.data.levels || {})
    setEditable(r.data.editable_sections || [])
    setHints(r.data.section_hints || {})
  })

  useEffect(() => {
    load().catch(e => setError(e.response?.data?.message || 'Не удалось получить должности'))
    getBalanceItemsList().then(r => setAccounts(r.data.data || [])).catch(() => {})
  }, [])

  const say = (msg) => { setNotice(msg); setError(''); setTimeout(() => setNotice(''), 4000) }

  const startNew = () => {
    // Новая должность начинается с просмотра везде: сузить проще, чем
    // вспомнить, что забыл открыть
    const permissions = Object.fromEntries(Object.keys(sections).map(s => [s, 'view']))
    permissions.users  = 'none'
    permissions.backup = 'none'
    setForm({ name: '', permissions, denied_accounts: [], sort_order: 50 })
    setError('')
    setShowAccounts(false)
  }

  const toggleAccount = (id) => setForm(f => {
    const denied = new Set(f.denied_accounts || [])
    denied.has(id) ? denied.delete(id) : denied.add(id)
    return { ...f, denied_accounts: [...denied] }
  })

  const save = async () => {
    if (!form.name.trim()) return setError('Название обязательно')
    setSaving(true); setError('')
    try {
      form.id ? await updateRole(form.id, form) : await createRole(form)
      setForm(null)
      await load()
      say('Должность сохранена')
    } catch (e) {
      setError(e.response?.data?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  const remove = async (r) => {
    if (!confirm(`Удалить должность «${r.name}»?`)) return
    try {
      await deleteRole(r.id)
      await load()
      say('Должность удалена')
    } catch (e) { setError(e.response?.data?.message || 'Не удалось удалить') }
  }

  const isAdminRole = form?.code === 'admin'

  return (
    <Layout>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Должности</h1>
          <p className="text-sm text-gray-500 mt-1">
            Набор прав по разделам. Уровни: нет доступа, просмотр, изменение.
          </p>
        </div>
        <button onClick={startNew}
          className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800">
          + Добавить должность
        </button>
      </div>

      {error &&  <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{error}</div>}
      {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3 mb-4">{notice}</div>}

      {form && (
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 mb-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Название</label>
              <input className={ic} value={form.name} autoFocus
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Кассир" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Порядок в списке</label>
              <input className={ic} type="number" value={form.sort_order}
                onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
            </div>
          </div>

          {isAdminRole && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Права администратора не ограничиваются: иначе компанию можно закрыть от самой себя.
              Меняется только название.
            </div>
          )}

          <div className="border border-gray-100 rounded-lg overflow-hidden">
            {Object.entries(sections).map(([key, label]) => {
              // В разделе, где нечего менять, третьей кнопки нет: переключатель
              // без действия хуже, чем его отсутствие. Сохранённое ранее
              // «изменение» показываем как просмотр — ровно так его и считает сервер
              const canEdit = editable.includes(key)
              const shown   = !canEdit && form.permissions[key] === 'edit' ? 'view' : form.permissions[key]
              const choices = Object.entries(levels).filter(([lvl]) => canEdit || lvl !== 'edit')

              return (
                <div key={key} className="flex items-center justify-between gap-4 px-4 py-2 border-b border-gray-50 last:border-0">
                  <span className="text-sm text-gray-700">
                    {label}
                    {!canEdit && <span className="block text-[11px] text-gray-400">раздел только читает</span>}
                    {hints[key] && <span className="block text-[11px] text-gray-400">{hints[key]}</span>}
                  </span>
                  <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 text-xs flex-shrink-0">
                    {choices.map(([lvl, lvlLabel]) => (
                      <button key={lvl} type="button" disabled={isAdminRole}
                        onClick={() => setForm(f => ({ ...f, permissions: { ...f.permissions, [key]: lvl } }))}
                        className={`px-3 py-1.5 rounded-md transition-colors disabled:opacity-60 ${
                          shown === lvl
                            ? 'bg-white shadow-sm text-gray-800 font-medium'
                            : 'text-gray-500 hover:text-gray-700'
                        }`}>
                        {lvlLabel}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Второй, поперечный разрез прав: раздел открыт целиком, но часть
              счетов из него вырезана. По умолчанию не закрыт ни один */}
          {!isAdminRole && (
            <div className="border border-gray-100 rounded-lg overflow-hidden">
              <button type="button" onClick={() => setShowAccounts(v => !v)}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-gray-50">
                <span className="text-gray-700">
                  Закрытые счета
                  <span className="text-gray-400 ml-2 text-xs">
                    {form.denied_accounts?.length
                      ? `отмечено: ${form.denied_accounts.length}`
                      : 'должность видит все счета'}
                  </span>
                </span>
                <span className="text-[10px] text-gray-400">{showAccounts ? '▲' : '▼'}</span>
              </button>

              {showAccounts && (
                <div className="border-t border-gray-100">
                  <p className="px-4 py-2 text-[11px] text-gray-500 bg-gray-50">
                    Отмеченные счета не видны в операциях, документах и отчётах. Отметка на группе
                    закрывает все счета внутри неё, включая те, что появятся позже.
                  </p>
                  {accounts.length === 0
                    ? <p className="px-4 py-3 text-sm text-gray-400">План счетов пуст</p>
                    : <AccountTree items={accounts} denied={new Set(form.denied_accounts || [])}
                        onToggle={toggleAccount} />}
                </div>
              )}
            </div>
          )}

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

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {roles === null ? (
          <div className="p-4"><SkeletonRows rows={2} /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-5 py-2">Должность</th>
                <th className="text-left px-5 py-2">Права</th>
                <th className="text-right px-5 py-2">Сотрудников</th>
                <th className="px-5 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {roles.map(r => (
                <tr key={r.id} className="border-b border-gray-50 last:border-0 align-top">
                  <td className="px-5 py-3">
                    <div className="font-medium text-gray-800">{r.name}</div>
                    {r.is_system && <div className="text-[11px] text-amber-600">заводская</div>}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(sections).map(([key, label]) => {
                        let lvl = r.permissions[key] || 'none'
                        // Должность могла быть сохранена до того, как из раздела
                        // убрали «изменение» — показываем то, чем это является
                        if (lvl === 'edit' && !editable.includes(key)) lvl = 'view'
                        if (lvl === 'none') return null
                        return (
                          <span key={key} className={`text-[10px] px-1.5 py-0.5 rounded ${LEVEL_STYLE[lvl]}`}>
                            {label}: {(levels[lvl] || lvl).toLowerCase()}
                          </span>
                        )
                      })}
                      {Object.values(r.permissions).every(l => l === 'none') && (
                        <span className="text-[11px] text-gray-400">нет доступа никуда</span>
                      )}
                    </div>
                    {r.denied_accounts?.length > 0 && (
                      <div className="text-[11px] text-gray-500 mt-1">
                        🔒 закрыто счетов: {r.denied_accounts.length}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-gray-600">{r.users_count || '—'}</td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <button onClick={() => { setForm({ ...r, denied_accounts: r.denied_accounts || [] }); setError(''); setShowAccounts(false) }}
                      className="text-xs text-blue-600 hover:text-blue-800 mr-3">Изменить</button>
                    {!r.is_system && (
                      <button onClick={() => remove(r)} className="text-xs text-red-400 hover:text-red-600">Удалить</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  )
}
