import { useState, useEffect } from 'react'
import { getInfo, createInfo, updateInfo, deleteInfo } from '../api/info'
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

const buildTree = (items) => {
  const map = {}
  const roots = []
  items.forEach(item => { map[item.id] = { ...item, children: [] } })
  items.forEach(item => {
    if (item.parent_id && map[item.parent_id]) map[item.parent_id].children.push(map[item.id])
    else roots.push(map[item.id])
  })
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      const orderA = a.sort_order || 0
      const orderB = b.sort_order || 0
      if (orderA !== orderB) return orderA - orderB
      return (a.name || '').localeCompare(b.name || '')
    })
    nodes.forEach(node => sortNodes(node.children))
  }
  sortNodes(roots)
  return roots
}

const flattenTree = (nodes, depth = 0, expandedSet = new Set()) => {
  let result = []
  nodes.forEach(node => {
    result.push({ ...node, depth })
    if (node.children && node.children.length > 0 && expandedSet.has(node.id)) {
      result = result.concat(flattenTree(node.children, depth + 1, expandedSet))
    }
  })
  return result
}

const emptyForm = { name: '', type: 'partner', description: '', inn: '', parent_id: '', sort_order: 0 }

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
      name:        item.name,
      type:        item.type,
      description: item.description || '',
      inn:         item.inn || '',
      parent_id:   item.parent_id || '',
      sort_order:  item.sort_order || 0,
    })
    setShowForm(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const payload = {
      name:       form.name,
      type:       form.type,
      inn:        form.inn || null,
      parent_id:  form.parent_id || null,
      sort_order: form.sort_order,
      description: form.description || null,
    }

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

  const toggleExpand = (type, id) => {
    setExpandedByType(prev => {
      const set = new Set(prev[type] || [])
      set.has(id) ? set.delete(id) : set.add(id)
      return { ...prev, [type]: set }
    })
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

      {/* Фильтр по типу */}
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
        <div className="text-center py-12 text-gray-400">Нет записей</div>
      ) : (
        Object.entries(grouped).map(([type, typeItems]) => {
          const typeLabel = INFO_TYPES.find(t => t.value === type)?.label || type
          const expandedSet = expandedByType[type] || new Set()
          const tree = buildTree(typeItems)
          const flat = flattenTree(tree, 0, expandedSet)

          return (
            <div key={type} className="bg-white rounded-xl border border-gray-100 shadow-sm mb-4 overflow-hidden">
              <div className="px-6 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">{typeLabel}</span>
                <span className="text-xs text-gray-400">{typeItems.length}</span>
              </div>
              <table className="w-full">
                <tbody>
                  {flat.map(item => (
                    <tr key={item.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 group">
                      <td className="px-6 py-2.5 w-8">
                        {item.children?.length > 0 && (
                          <button onClick={() => toggleExpand(type, item.id)}
                            className="text-gray-400 hover:text-gray-600 text-xs">
                            {expandedSet.has(item.id) ? '▼' : '▶'}
                          </button>
                        )}
                      </td>
                      <td className="py-2.5 pr-4" style={{ paddingLeft: `${24 + item.depth * 20}px` }}>
                        <span className="text-sm text-gray-800">
                          {item.depth > 0 && <span className="text-gray-300 mr-1.5">└</span>}
                          {item.name}
                        </span>
                        {/* Показываем ИНН для partner */}
                        {item.type === 'partner' && item.inn && (
                          <span className="ml-2 text-xs text-gray-400">ИНН: {item.inn}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        {item.code && (
                          <span className="text-xs font-mono bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{item.code}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-6 text-right">
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-2 justify-end">
                          <button onClick={() => openEdit(item)}
                            className="text-xs text-blue-600 hover:text-blue-800">Изменить</button>
                          <button onClick={() => handleDelete(item.id)}
                            className="text-xs text-red-400 hover:text-red-600">Удалить</button>
                        </div>
                      </td>
                    </tr>
                  ))}
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
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-800">
                {editItem ? 'Редактировать' : 'Новая запись'}
              </h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

              {/* Тип */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Тип</label>
                <select value={form.type}
                  onChange={e => setForm({ ...form, type: e.target.value, description: '', inn: '' })}
                  className={ic} required>
                  {INFO_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              {/* Родитель */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Родитель</label>
                <select value={form.parent_id} onChange={e => setForm({ ...form, parent_id: e.target.value })} className={ic}>
                  <option value="">— Без родителя</option>
                  {(() => {
                    const sameType = items.filter(i => i.type === form.type && i.id !== editItem?.id)
                    const tree = buildTree(sameType)
                    const flat = flattenTree(tree, 0, new Set(sameType.map(i => i.id)))
                    return flat.map(item => (
                      <option key={item.id} value={item.id}>
                        {'\u00A0'.repeat(item.depth * 2)}{item.depth > 0 ? '└ ' : ''}{item.name}
                      </option>
                    ))
                  })()}
                </select>
              </div>

              {/* Название */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Название</label>
                <input type="text" value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Название" className={ic} required autoFocus />
              </div>

              {/* ИНН — только для partner */}
              {form.type === 'partner' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    ИНН
                    <span className="ml-1 text-xs text-gray-400 font-normal">для автосопоставления из выписки</span>
                  </label>
                  <input
                    type="text"
                    value={form.inn || ''}
                    onChange={e => setForm({ ...form, inn: e.target.value })}
                    placeholder="7704217370"
                    className={ic + ' font-mono'}
                    maxLength={12}
                  />
                </div>
              )}

              {/* Описание */}
              {(
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Описание</label>
                  <input type="text" value={form.description}
                    onChange={e => setForm({ ...form, description: e.target.value })}
                    placeholder="Необязательно" className={ic} />
                </div>
              )}

              {/* Порядок сортировки */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Порядок сортировки</label>
                <input type="number" value={form.sort_order}
                  onChange={e => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
                  placeholder="0" className={ic} />
                <p className="text-[10px] text-gray-400 mt-1">Меньше число — выше в списке</p>
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
