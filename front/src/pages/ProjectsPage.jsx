import { useState, useEffect } from 'react'
import { getProjects, createProject, updateProject, deleteProject } from '../api/projects'
import Layout from '../components/Layout'

const ic = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

// Частые валюты и часовые пояса — для выпадашек. Можно ввести своё значение.
const CURRENCIES = ['RUB', 'USD', 'EUR', 'KZT', 'BYN', 'UAH', 'CNY']
const TIMEZONES = [
  'Europe/Moscow',
  'Europe/Kaliningrad',
  'Asia/Yekaterinburg',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Vladivostok',
  'Asia/Almaty',
]

const emptyForm = { name: '', currency: 'RUB', timezone: 'Europe/Moscow', parent_id: '' }

export default function ProjectsPage() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  // editId: null — форма закрыта; 'new' — создание; число — редактирование проекта.
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState(emptyForm)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await getProjects()
      setProjects(res.data.data || [])
    } catch (e) {
      setError('Не удалось загрузить проекты')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const openCreate = () => {
    setEditId('new')
    setForm({ ...emptyForm })
    setNotice('')
    setError('')
  }

  const openEdit = (p) => {
    setEditId(p.id)
    setForm({
      name: p.name || '',
      currency: p.currency || 'RUB',
      timezone: p.timezone || 'Europe/Moscow',
      parent_id: p.parent_id ?? '',
    })
    setNotice('')
    setError('')
  }

  const closeForm = () => {
    setEditId(null)
    setForm(emptyForm)
  }

  const save = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const payload = {
        name: form.name.trim(),
        currency: form.currency || 'RUB',
        timezone: form.timezone || 'Europe/Moscow',
        parent_id: form.parent_id || null,
      }
      if (editId === 'new') {
        await createProject(payload)
        setNotice('Проект создан')
      } else {
        await updateProject(editId, payload)
        setNotice('Изменения сохранены')
      }
      closeForm()
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось сохранить проект')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (p) => {
    if (!confirm(`Удалить проект «${p.name}»?`)) return
    setError('')
    setNotice('')
    try {
      await deleteProject(p.id)
      setNotice('Проект удалён')
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось удалить проект')
    }
  }

  const parentName = (id) => projects.find(p => p.id === id)?.name || `#${id}`

  const renderForm = () => (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="text-sm font-medium text-gray-700">
        {editId === 'new' ? 'Новый проект' : 'Редактирование проекта'}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Название</label>
          <input
            className={ic}
            value={form.name}
            placeholder="например: Основная деятельность"
            autoFocus
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') closeForm() }}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Родительский проект</label>
          <select
            className={ic}
            value={form.parent_id}
            onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))}
          >
            <option value="">— Без родителя</option>
            {projects.filter(p => p.id !== editId).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Валюта</label>
          <select
            className={ic}
            value={form.currency}
            onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
          >
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            {form.currency && !CURRENCIES.includes(form.currency) && (
              <option value={form.currency}>{form.currency}</option>
            )}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Часовой пояс</label>
          <select
            className={ic}
            value={form.timezone}
            onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}
          >
            {TIMEZONES.map(t => <option key={t} value={t}>{t}</option>)}
            {form.timezone && !TIMEZONES.includes(form.timezone) && (
              <option value={form.timezone}>{form.timezone}</option>
            )}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={closeForm} className="px-4 py-2 text-gray-600 text-sm">Отмена</button>
        <button
          onClick={save}
          disabled={saving || !form.name.trim()}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>
  )

  return (
    <Layout>
      <div className="max-w-4xl mx-auto py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Проекты</h1>
          <p className="text-sm text-gray-500 mt-1">
            Направления учёта. Каждая операция и документ относятся к проекту.
            Проект можно вложить в другой для иерархии.
          </p>
        </div>

        {error &&  <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}
        {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3">{notice}</div>}

        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Список проектов</h2>
            {editId !== 'new' && (
              <button onClick={openCreate} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                + Проект
              </button>
            )}
          </div>

          {editId === 'new' && <div className="mb-4">{renderForm()}</div>}

          {loading ? (
            <div className="text-sm text-gray-500 py-8 text-center">Загрузка…</div>
          ) : projects.length === 0 ? (
            <div className="text-sm text-gray-500 py-8 text-center">
              Проектов нет. Нажмите «+ Проект», чтобы добавить первый.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="pb-2 pr-3 font-medium">Название</th>
                  <th className="pb-2 pr-3 font-medium">Родитель</th>
                  <th className="pb-2 pr-3 font-medium">Валюта</th>
                  <th className="pb-2 pr-3 font-medium">Часовой пояс</th>
                  <th className="pb-2 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {projects.map(p => (
                  editId === p.id ? (
                    <tr key={p.id}>
                      <td colSpan={5} className="py-3">{renderForm()}</td>
                    </tr>
                  ) : (
                    <tr key={p.id} className="border-b border-gray-50">
                      <td className="py-2 pr-3 font-medium text-gray-800">{p.name}</td>
                      <td className="py-2 pr-3 text-gray-500">{p.parent_id ? parentName(p.parent_id) : '—'}</td>
                      <td className="py-2 pr-3 text-gray-600">{p.currency}</td>
                      <td className="py-2 pr-3 text-gray-600">{p.timezone}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button onClick={() => openEdit(p)} className="text-gray-400 hover:text-blue-600 text-sm px-1.5" title="Редактировать">✎</button>
                        <button onClick={() => remove(p)} className="text-gray-400 hover:text-red-600 text-sm px-1.5" title="Удалить">✕</button>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}
