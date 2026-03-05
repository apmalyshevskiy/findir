import { useState, useEffect } from 'react'
import { getInfo, createInfo, updateInfo, deleteInfo } from '../api/info'
import { buildTree, flattenTree } from '../lib/utils'
import Layout from '../components/Layout'

const INFO_TYPES = [
  { value: 'partner',    label: 'Контрагенты' },
  { value: 'product',    label: 'Товары/Услуги' },
  { value: 'cash',       label: 'Кассы/Счета' },
  { value: 'employee',   label: 'Сотрудники' },
  { value: 'revenue',    label: 'Статьи доходов' },
  { value: 'expenses',   label: 'Статьи расходов' },
  { value: 'department', label: 'Отделы' },
  { value: 'flow',       label: 'Статьи движения' },
]

const emptyForm = { name: '', type: 'partner', description: '', parent_id: '' }

export default function InfoPage() {
  const [items, setItems] = useState([])
  const [filterType, setFilterType] = useState('')
  const [expandedByType, setExpandedByType] = useState({})
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { loadItems() }, [filterType])

  const loadItems = () => {
    setLoading(true)
    getInfo(filterType ? { type: filterType } : {})
      .then(res => setItems(res.data.data))
      .finally(() => setLoading(false))
  }

  const openCreate = () => {
    setEditItem(null)
    setForm({ ...emptyForm, type: filterType || 'partner' })
    setShowForm(true)
  }

  const openEdit = (item) => {
    setEditItem(item)
    setForm({
      name: item.name,
      type: item.type,
      description: item.description || '',
      parent_id: item.parent_id || '',
    })
    setShowForm(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const payload = { ...form, parent_id: form.parent_id || null }
    try {
      editItem ? await updateInfo(editItem.id, payload) : await createInfo(payload)
      setShowForm(false)
      loadItems()
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Удалить запись?')) return
    await deleteInfo(id)
    loadItems()
  }

  const ic = "w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"

  const grouped = filterType
    ? { [filterType]: items }
    : INFO_TYPES.reduce((acc, t) => {
        const f = items.filter(i => i.type === t.value)
        if (f.length > 0) acc[t.value] = f
        return acc
      }, {})

  return (
    <Layout>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-semibold text-gray-800">Справочники</h2>
        <button onClick={openCreate}
          className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors">
          + Добавить
        </button>
      </div>

      {/* Фильтр */}
      <div className="flex gap-2 flex-wrap mb-6">
        <button onClick={() => setFilterType('')}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterType === '' ? 'bg-blue-900 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
          Все
        </button>
        {INFO_TYPES.map(t => (
          <button key={t.value} onClick={() => setFilterType(t.value)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterType === t.value ? 'bg-blue-900 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Список */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Загрузка...</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <p className="text-gray-400 mb-3">Справочник пуст</p>
          <button onClick={openCreate} className="text-blue-600 hover:underline text-sm">Добавить первую запись</button>
        </div>
      ) : (
        Object.entries(grouped).map(([type, typeItems]) => {
          const typeLabel = INFO_TYPES.find(t => t.value === type)?.label || type
          const tree = buildTree(typeItems)
          const expanded = expandedByType[type]
          const flat = flattenTree(tree, 0, expanded ?? null)
          return (
            <div key={type} className="bg-white rounded-xl border border-gray-100 shadow-sm mb-4">
              {!filterType && (
                <div className="px-6 py-3 border-b border-gray-100 flex justify-between items-center">
                  <h3 className="font-medium text-gray-700 text-sm">{typeLabel}</h3>
                  <span className="text-xs text-gray-400">{typeItems.length}</span>
                </div>
              )}
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-gray-50">
                    <th className="text-left px-6 py-2 w-12">#</th>
                    <th className="text-left px-6 py-2">Название</th>
                    <th className="text-left px-6 py-2">Описание</th>
                    <th className="px-6 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {flat.map(item => {
                    const hasChildren = item.children?.length > 0
                    const isExpanded = (expanded ?? null) === null || expanded.has(item.id)
                    const toggle = () => {
                      setExpandedByType(prev => {
                        const next = { ...prev }
                        const curr = next[type]
                        const newSet = curr instanceof Set ? new Set(curr) : null
                        if (isExpanded) {
                          const s = newSet ?? (() => {
                            const ids = new Set()
                            const collect = (nodes) => nodes.forEach(n => { if (n.children?.length) ids.add(n.id); collect(n.children || []) })
                            collect(tree)
                            return ids
                          })()
                          s.delete(item.id)
                          next[type] = s
                        } else {
                          const s = newSet ?? new Set()
                          s.add(item.id)
                          next[type] = s
                        }
                        return next
                      })
                    }
                    return (
                    <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 group transition-colors">
                      <td className="px-6 py-3 text-xs text-gray-400 font-mono">{item.id}</td>
                      <td className="px-6 py-3 text-sm font-medium text-gray-800" style={{ paddingLeft: 12 + item.depth * 20 }}>
                        {hasChildren ? (
                          <button type="button" onClick={toggle} className="mr-2 text-gray-400 hover:text-gray-600 inline-flex items-center justify-center w-5 h-5 rounded">
                            {isExpanded ? '▼' : '▶'}
                          </button>
                        ) : (
                          <span className="inline-block w-5 mr-2" />
                        )}
                        {item.depth > 0 && <span className="text-gray-300 mr-2">└</span>}
                        {item.name}
                      </td>
                      <td className="px-6 py-3 text-sm text-gray-400">{item.description || '—'}</td>
                      <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => openEdit(item)}
                            className="text-gray-400 hover:text-blue-600 text-sm px-2 py-1 rounded hover:bg-blue-50">✎</button>
                          <button onClick={() => handleDelete(item.id)}
                            className="text-gray-400 hover:text-red-500 text-lg px-1">×</button>
                        </div>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          )
        })
      )}

      {/* Форма */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editItem ? 'Редактировать' : 'Новая запись'}</h3>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Тип</label>
                <select value={form.type} onChange={e => setForm({...form, type: e.target.value})} className={ic} required>
                  {INFO_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Родитель</label>
                <select value={form.parent_id} onChange={e => setForm({...form, parent_id: e.target.value})} className={ic}>
                  <option value="">— Без родителя</option>
                  {(() => {
                    const sameType = items.filter(i => i.type === form.type && i.id !== editItem?.id)
                    const tree = buildTree(sameType)
                    const flat = flattenTree(tree)
                    return flat.map(item => (
                      <option key={item.id} value={item.id}>
                        {'\u00A0'.repeat(item.depth * 2)}{item.depth > 0 ? '└ ' : ''}{item.name}
                      </option>
                    ))
                  })()}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Название</label>
                <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                  placeholder="Название" className={ic} required autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Описание</label>
                <input type="text" value={form.description} onChange={e => setForm({...form, description: e.target.value})}
                  placeholder="Необязательно" className={ic} />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
                  Отмена
                </button>
                <button type="submit" disabled={loading}
                  className="flex-1 px-4 py-2.5 bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50 text-sm font-medium">
                  {loading ? 'Сохранение...' : editItem ? 'Обновить' : 'Сохранить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Layout>
  )
}
