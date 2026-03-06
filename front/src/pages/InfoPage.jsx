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

// 1. НАДЕЖНАЯ ФУНКЦИЯ СБОРКИ ДЕРЕВА С ЖЕСТКОЙ СОРТИРОВКОЙ
const buildTree = (items) => {
  const map = {}
  const roots = []
  
  items.forEach(item => {
    map[item.id] = { ...item, children: [] }
  })
  
  items.forEach(item => {
    if (item.parent_id && map[item.parent_id]) {
      map[item.parent_id].children.push(map[item.id])
    } else {
      roots.push(map[item.id])
    }
  })

  // Рекурсивная сортировка каждого уровня дерева
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      const orderA = a.sort_order || 0
      const orderB = b.sort_order || 0
      if (orderA !== orderB) return orderA - orderB // Сначала по числу sort_order
      return (a.name || '').localeCompare(b.name || '') // Затем по алфавиту
    })
    nodes.forEach(node => sortNodes(node.children))
  }
  
  sortNodes(roots)
  return roots
}

// 2. НАДЕЖНАЯ ФУНКЦИЯ РАЗВЕРТЫВАНИЯ (ПО УМОЛЧАНИЮ СВЕРНУТО)
const flattenTree = (nodes, depth = 0, expandedSet = new Set()) => {
  let result = []
  nodes.forEach(node => {
    result.push({ ...node, depth })
    // Добавляем детей ТОЛЬКО если родитель есть в списке развернутых (expandedSet)
    if (node.children && node.children.length > 0 && expandedSet.has(node.id)) {
      result = result.concat(flattenTree(node.children, depth + 1, expandedSet))
    }
  })
  return result
}

const emptyForm = { name: '', type: 'partner', description: '', parent_id: '', sort_order: 0 }

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
      sort_order: item.sort_order || 0,
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
          
          // Жестко передаем пустой Set(), если ветки еще не открывали
          const expanded = expandedByType[type] || new Set()
          const flat = flattenTree(tree, 0, expanded)
          
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
                    <th className="text-left px-6 py-2 w-20 text-center">Сорт.</th>
                    <th className="text-left px-6 py-2">Описание</th>
                    <th className="px-6 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {flat.map(item => {
                    const hasChildren = item.children?.length > 0
                    const isExpanded = expanded.has(item.id)
                    
                    const toggle = () => {
                      setExpandedByType(prev => {
                        const next = { ...prev }
                        const s = new Set(next[type] || [])
                        if (isExpanded) s.delete(item.id)
                        else s.add(item.id)
                        next[type] = s
                        return next
                      })
                    }
                    return (
                    <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50 group transition-colors">
                      <td className="px-6 py-3 text-xs text-gray-400 font-mono">{item.id}</td>
                      <td className="px-6 py-3 text-sm font-medium text-gray-800">
                        <div className="flex items-center" style={{ paddingLeft: item.depth * 20 }}>
                          {hasChildren ? (
                            <button 
                              type="button" 
                              onClick={toggle} 
                              className="mr-2 text-gray-400 hover:text-gray-600 inline-flex items-center justify-center w-5 h-5 rounded transition-colors"
                            >
                              <svg 
                                className={`w-3 h-3 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} 
                                viewBox="0 0 24 24" fill="currentColor"
                              >
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </button>
                          ) : (
                            <span className="inline-block w-5 mr-2 text-center text-gray-300 text-xs">
                              {item.depth > 0 ? '└' : ''}
                            </span>
                          )}
                          <span className="truncate">{item.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-3 text-xs text-center text-gray-400 font-mono">{item.sort_order}</td>
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
                    // Для селекта раскрываем всё, чтобы было видно все варианты
                    const flat = flattenTree(tree, 0, new Set(sameType.map(i => i.id)))
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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Порядок сортировки</label>
                <input 
                  type="number" 
                  value={form.sort_order} 
                  onChange={e => setForm({...form, sort_order: parseInt(e.target.value) || 0})}
                  placeholder="0" 
                  className={ic} 
                />
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