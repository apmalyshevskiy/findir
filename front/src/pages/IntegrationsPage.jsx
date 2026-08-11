import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import IntegrationSettingsForm from '../components/IntegrationSettingsForm'
import {
  getIntegrationTypes, getIntegrations, createIntegration, updateIntegration,
  deleteIntegration, testIntegration,
} from '../api/integrations'

/**
 * Настройки интеграций: связь с учётной системой и правила переноса.
 *
 * Сама загрузка живёт на отдельной странице — сюда заходят один раз при
 * подключении и потом почти никогда.
 */

export default function IntegrationsPage() {
  const [types, setTypes]   = useState({})
  const [items, setItems]   = useState([])
  const [editing, setEditing] = useState(null)   // { id?, type, name, is_active, settings, credentials }
  const [busy, setBusy]     = useState('')
  const [notice, setNotice] = useState(null)     // { kind, text }

  const load = () => getIntegrations().then(r => setItems(r.data.data || [])).catch(() => {})

  useEffect(() => {
    getIntegrationTypes().then(r => setTypes(r.data.data || {})).catch(() => {})
    load()
  }, [])

  const openNew = (type) => {
    setNotice(null)
    setEditing({
      type,
      name: types[type]?.label || type,
      is_active: true,
      settings: Object.fromEntries((types[type]?.settings || [])
        .filter(f => 'default' in f).map(f => [f.key, f.default])),
      credentials: {},
    })
  }

  // Несекретные доступы (домен) приходят с сервера и подставляются в форму:
  // иначе поле открывается пустым и не видно, с чем система работает сейчас
  const toForm = (item) => ({
    ...item,
    settings: { ...(item.settings || {}), __has_credentials: item.has_credentials },
    credentials: { ...(item.credentials || {}) },
  })

  const openEdit = (item) => {
    setNotice(null)
    setEditing(toForm(item))
  }

  const persist = async () => {
    const { __has_credentials, ...settings } = editing.settings || {}
    const payload = {
      name: editing.name,
      is_active: editing.is_active,
      settings,
      credentials: editing.credentials || {},
    }
    const r = editing.id
      ? await updateIntegration(editing.id, payload)
      : await createIntegration({ ...payload, type: editing.type })

    const saved = toForm(r.data.data)
    setEditing(saved)
    load()
    return saved
  }

  const save = async () => {
    setBusy('save'); setNotice(null)
    try {
      await persist()
      setNotice({ kind: 'ok', text: 'Настройки сохранены' })
    } catch (e) {
      setNotice({ kind: 'error', text: e.response?.data?.message || 'Не удалось сохранить' })
    } finally { setBusy('') }
  }

  // Проверяем то, что на экране: сперва сохраняем, иначе связь проверялась бы
  // со старым доменом, пока человек смотрит на исправленный
  const test = async () => {
    setBusy('test'); setNotice(null)
    try {
      const saved = await persist()
      const r = await testIntegration(saved.id)
      setNotice({ kind: 'ok', text: r.data.message })
    } catch (e) {
      setNotice({ kind: 'error', text: e.response?.data?.message || 'Связи нет' })
    } finally { setBusy('') }
  }

  const remove = async (item) => {
    if (!confirm(`Удалить интеграцию «${item.name}»? Загруженные документы останутся, но связь с источником потеряется — повторная загрузка создаст их заново.`)) return
    await deleteIntegration(item.id)
    setEditing(null); load()
  }

  const noticeCls = {
    ok:    'bg-green-50 border-green-200 text-green-800',
    warn:  'bg-amber-50 border-amber-200 text-amber-900',
    error: 'bg-red-50 border-red-200 text-red-700',
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">Интеграции</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Связь с учётной системой и правила переноса. Заполняется один раз —
            загрузка данных живёт на странице{' '}
            <Link to="/data-import" className="text-blue-700 hover:underline">Загрузка</Link>.
          </p>
        </div>
        <div className="flex gap-2">
          {Object.entries(types).map(([key, t]) => (
            <button key={key} onClick={() => openNew(key)}
              className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
              + {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr] items-start">

        {/* ── Список ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-3">
          {items.length === 0 && (
            <div className="text-sm text-gray-500 p-3">
              Пока ни одной. Интеграция забирает данные из учётной системы и раскладывает
              их по счетам FINDIR — руками вводить ничего не придётся.
            </div>
          )}
          {items.map(i => (
            <button key={i.id} onClick={() => openEdit(i)}
              className={'w-full text-left px-3 py-2.5 rounded-lg mb-1 ' +
                (editing?.id === i.id ? 'bg-blue-50' : 'hover:bg-gray-50')}>
              <div className="flex items-center gap-2">
                <span className={'w-2 h-2 rounded-full shrink-0 ' + (i.is_active ? 'bg-green-500' : 'bg-gray-300')} />
                <span className="text-sm font-medium text-gray-800 truncate">{i.name}</span>
              </div>
              <div className="text-[11px] text-gray-400 mt-0.5 pl-4">
                {types[i.type]?.label || i.type}
                {!i.is_ready && <span className="text-amber-700"> · не настроена до конца</span>}
              </div>
            </button>
          ))}
        </div>

        {/* ── Карточка ────────────────────────────────────────────── */}
        {editing ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 space-y-6">

            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[220px]">
                <label className="block text-sm font-medium text-gray-700 mb-1">Название</label>
                <input className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <input type="checkbox" className="w-4 h-4 accent-blue-900"
                  checked={!!editing.is_active}
                  onChange={e => setEditing({ ...editing, is_active: e.target.checked })} />
                <span className="text-sm text-gray-700">Включена</span>
              </label>
            </div>

            {notice && (
              <div className={`border rounded-lg px-4 py-3 text-sm ${noticeCls[notice.kind]}`}>{notice.text}</div>
            )}

            {types[editing.type] && (
              <IntegrationSettingsForm
                schema={types[editing.type]}
                values={editing.settings}
                onChange={s => setEditing({ ...editing, settings: s })}
                credentials={editing.credentials}
                onCredentials={c => setEditing({ ...editing, credentials: c })}
                integrationId={editing.id}
              />
            )}

            <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
              <button onClick={save} disabled={busy === 'save'}
                className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
                {busy === 'save' ? 'Сохраняю...' : 'Сохранить'}
              </button>
              <button onClick={test} disabled={busy === 'test'}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-40">
                {busy === 'test' ? 'Проверяю...' : 'Сохранить и проверить связь'}
              </button>
              {editing.id && (
                <button onClick={() => remove(editing)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-red-600 ml-auto">
                  Удалить
                </button>
              )}
            </div>

            {editing.id && (
              <div className="pt-4 border-t border-gray-100 text-sm text-gray-500">
                Настроили — дальше грузите данные на странице{' '}
                <Link to="/data-import" className="text-blue-700 hover:underline font-medium">Загрузка</Link>.
                Сюда возвращаться не нужно.
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-sm text-gray-500">
            Выберите интеграцию слева или добавьте новую.
          </div>
        )}
      </div>
    </Layout>
  )
}
