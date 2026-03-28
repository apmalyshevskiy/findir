import { useState, useEffect } from 'react'
import { getBalanceItems, createOperation, updateOperation } from '../api/operations'
import { getInfo, createInfo, updateInfo } from '../api/info'

const INFO_LABELS = {
  partner:    'Контрагент',
  product:    'Товар/Услуга',
  cash:       'Касса/Счёт',
  employee:   'Сотрудник',
  revenue:    'Статья дохода',
  expenses:   'Статья расхода',
  department: 'Отдел',
  flow:       'Статья движения',
}

// 1. Функции для работы с иерархией (как в справочниках)
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

// Разворачиваем дерево в плоский список с учетом глубины
const flattenTree = (nodes, depth = 0) => {
  let result = []
  nodes.forEach(node => {
    result.push({ ...node, depth })
    if (node.children && node.children.length > 0) {
      result = result.concat(flattenTree(node.children, depth + 1))
    }
  })
  return result
}

// 2. Кастомный компонент селекта с поиском, иерархией, inline-созданием и редактированием
const SearchableInfoSelect = ({ items, value, onChange, label, infoType, onItemCreated }) => {
  const [search, setSearch] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  // mode: null | 'create' | 'edit'
  const [formMode, setFormMode] = useState(null)
  const [editId, setEditId] = useState(null)
  const [newName, setNewName] = useState('')
  const [newParentId, setNewParentId] = useState('')
  const [saving, setSaving] = useState(false)

  // Строим дерево и разворачиваем его для отображения
  const tree = buildTree(items || [])
  const flatItems = flattenTree(tree)

  // Фильтруем элементы, если пользователь начал вводить текст
  const filtered = flatItems.filter(opt =>
    opt.name.toLowerCase().includes(search.toLowerCase()) ||
    (opt.code && opt.code.toLowerCase().includes(search.toLowerCase()))
  )

  const selectedOption = items?.find(o => o.id == value)

  const resetForm = () => {
    setFormMode(null)
    setEditId(null)
    setNewName('')
    setNewParentId('')
  }

  const handleCreate = async () => {
    if (!newName.trim() || !infoType) return
    setSaving(true)
    try {
      const res = await createInfo({ name: newName.trim(), type: infoType, parent_id: newParentId || null })
      const created = res.data.data
      if (onItemCreated) onItemCreated(infoType, created)
      onChange(created.id)
      resetForm()
      setSearch('')
      setIsOpen(false)
    } catch (err) {
      console.error('Ошибка создания:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async () => {
    if (!newName.trim() || !editId) return
    setSaving(true)
    try {
      const original = items?.find(o => o.id == editId)
      const res = await updateInfo(editId, { name: newName.trim(), type: infoType, parent_id: newParentId || null })
      const updated = res.data.data
      // Обновляем элемент в кеше
      if (onItemCreated) onItemCreated(infoType, updated, editId)
      resetForm()
      setSearch('')
      setIsOpen(false)
    } catch (err) {
      console.error('Ошибка обновления:', err)
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (e) => {
    e.stopPropagation()
    if (!selectedOption) return
    setFormMode('edit')
    setEditId(selectedOption.id)
    setNewName(selectedOption.name || '')
    setNewParentId(selectedOption.parent_id || '')
    setIsOpen(true)
  }

  return (
    <div className="relative flex flex-col gap-1">
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      <div className="relative flex items-center gap-1">
        <div className="relative flex-1">
          <input
            type="text"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={selectedOption ? selectedOption.name : "Выберите значение..."}
            value={search}
            onFocus={() => { setIsOpen(true); if (formMode === 'edit') resetForm() }}
            onChange={(e) => {
              setSearch(e.target.value)
              setIsOpen(true)
              resetForm()
            }}
          />
        </div>
        {/* Карандашик — редактирование выбранного элемента */}
        {selectedOption && infoType && (
          <button
            type="button"
            onClick={openEdit}
            className="flex-shrink-0 p-1.5 text-gray-300 hover:text-gray-500 transition-colors"
            title={`Переименовать «${selectedOption.name}»`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              <path d="m15 5 4 4"/>
            </svg>
          </button>
        )}
        {/* Выпадающий список */}
        {isOpen && (
          <div className="absolute left-0 right-0 top-full z-[60] mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
            {formMode !== 'edit' && (
              <>
                <div
                  className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 cursor-pointer border-b border-gray-100"
                  onClick={() => {
                    onChange('')
                    setSearch('')
                    setIsOpen(false)
                    resetForm()
                  }}
                >
                  Не указано
                </div>
                {filtered.length > 0 ? filtered.map(opt => (
                  <div
                    key={opt.id}
                    className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer flex justify-between items-center group"
                    onClick={() => {
                      onChange(opt.id)
                      setSearch('')
                      setIsOpen(false)
                      resetForm()
                    }}
                  >
                    <span style={{ paddingLeft: search ? 0 : opt.depth * 16 }} className="truncate">
                      {!search && opt.depth > 0 && <span className="text-gray-300 mr-1.5">└</span>}
                      <span className={(!search && opt.children?.length > 0) ? "font-medium text-gray-800" : "text-gray-700 group-hover:text-blue-700"}>
                        {opt.name}
                      </span>
                    </span>
                    {opt.code && <span className="text-gray-400 text-[10px] font-mono ml-2">{opt.code}</span>}
                  </div>
                )) : formMode !== 'create' && <div className="px-3 py-2 text-sm text-gray-400">Ничего не найдено</div>}

                {/* Кнопка создания */}
                {infoType && formMode !== 'create' && (
                  <div
                    className="px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 cursor-pointer border-t border-gray-100 flex items-center gap-1.5"
                    onClick={(e) => {
                      e.stopPropagation()
                      setFormMode('create')
                      setEditId(null)
                      setNewName(search)
                      setNewParentId('')
                    }}
                  >
                    <span className="text-blue-500">+</span> Создать «{search || INFO_LABELS[infoType] || infoType}»
                  </div>
                )}
              </>
            )}

            {/* Inline-форма создания / редактирования */}
            {formMode && (
              <div className="p-3 border-t border-gray-100 bg-gray-50 space-y-2" onClick={e => e.stopPropagation()}>
                <div className="text-xs text-gray-500 font-medium">
                  {formMode === 'edit' ? `Редактировать: ${selectedOption?.name || ''}` : `Новый: ${INFO_LABELS[infoType] || infoType}`}
                </div>
                <input
                  type="text"
                  className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Название"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); formMode === 'edit' ? handleUpdate() : handleCreate() }
                    if (e.key === 'Escape') resetForm()
                  }}
                  autoFocus
                />
                <select
                  className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-600"
                  value={newParentId}
                  onChange={e => setNewParentId(e.target.value)}
                >
                  <option value="">— Без родителя</option>
                  {flatItems.filter(o => o.id != editId).map(opt => (
                    <option key={opt.id} value={opt.id}>
                      {'\u00A0'.repeat(opt.depth * 2)}{opt.depth > 0 ? '└ ' : ''}{opt.name}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={formMode === 'edit' ? handleUpdate : handleCreate}
                    disabled={!newName.trim() || saving}
                    className="flex-1 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? '...' : formMode === 'edit' ? 'Сохранить' : 'Создать'}
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-sm border border-gray-200 rounded-lg"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {isOpen && <div className="fixed inset-0 z-[55]" onClick={() => { setIsOpen(false); resetForm() }}></div>}
    </div>
  )
}

export default function OperationForm({ operation, onSuccess, onCancel }) {
  const isEdit = !!operation
  const [balanceItems, setBalanceItems] = useState([])
  const [infoCache, setInfoCache] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    date:          operation
      ? new Date(new Date(operation.date).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16),
    project_id:    operation?.project_id ?? 1,
    amount:        operation?.amount ?? '',
    in_bi_id:      operation?.in_bi_id ?? '',
    out_bi_id:     operation?.out_bi_id ?? '',
    in_info_1_id:  operation?.in_info_1_id ?? '',
    in_info_2_id:  operation?.in_info_2_id ?? '',
    out_info_1_id: operation?.out_info_1_id ?? '',
    out_info_2_id: operation?.out_info_2_id ?? '',
    content:          operation?.content ?? '',
    note:          operation?.note ?? '',
    
    }) 

  useEffect(() => {
    getBalanceItems().then(res => {
      const items = res.data.data
      setBalanceItems(items)

      if (isEdit) {
        const inBi  = items.find(b => b.id == operation.in_bi_id)
        const outBi = items.find(b => b.id == operation.out_bi_id)
        const types = [...new Set([
          inBi?.info_1_type, inBi?.info_2_type,
          outBi?.info_1_type, outBi?.info_2_type,
        ].filter(Boolean))]

        types.forEach(type => {
          getInfo({ type }).then(r => {
            setInfoCache(prev => ({ ...prev, [type]: r.data.data }))
          })
        })
      }
    })
  }, [])

  const loadInfoForBi = (biId, prevCache) => {
    const bi = balanceItems.find(b => b.id == biId)
    const types = [bi?.info_1_type, bi?.info_2_type].filter(Boolean)
    types.forEach(type => {
      if (!prevCache[type]) {
        getInfo({ type }).then(r => {
          setInfoCache(prev => ({ ...prev, [type]: r.data.data }))
        })
      }
    })
  }

  // Callback для inline-создания: добавляем элемент в кеш
  // Callback для inline-создания/редактирования: добавляем или обновляем элемент в кеше
  const handleItemCreated = (type, newItem, replaceId = null) => {
    setInfoCache(prev => {
      const list = prev[type] || []
      if (replaceId) {
        return { ...prev, [type]: list.map(i => i.id == replaceId ? newItem : i) }
      }
      return { ...prev, [type]: [...list, newItem] }
    })
  }

  const inBi  = balanceItems.find(b => b.id == form.in_bi_id)
  const outBi = balanceItems.find(b => b.id == form.out_bi_id)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      isEdit ? await updateOperation(operation.id, form) : await createOperation(form)
      onSuccess()
    } catch (err) {
      const errors = err.response?.data?.errors
      setError(errors ? Object.values(errors).flat().join(', ') : err.response?.data?.message || 'Ошибка')
    } finally {
      setLoading(false)
    }
  }

  const ic = "w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
  const lc = "block text-sm font-medium text-gray-700 mb-1"

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg my-4">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-800">
            {isEdit ? 'Редактировать операцию' : 'Новая операция'}
          </h3>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lc}>Дата и время</label>
              <input type="datetime-local" value={form.date}
                onChange={e => setForm({...form, date: e.target.value})}
                className={ic} required />
            </div>
            <div>
              <label className={lc}>Сумма (₽)</label>
              <input type="number" value={form.amount}
                onChange={e => setForm({...form, amount: e.target.value})}
                placeholder="0.00" step="0.01" className={ic} required />
            </div>
          </div>

          {/* Дебет */}
          <div>
            <label className={lc}>Дебет (куда)</label>
            <select value={form.in_bi_id}
              onChange={e => {
                setForm({...form, in_bi_id: e.target.value, in_info_1_id: '', in_info_2_id: ''})
                loadInfoForBi(e.target.value, infoCache)
              }}
              className={ic} required>
              <option value="">Выберите счёт...</option>
              {balanceItems.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}
            </select>
          </div>

          {inBi?.info_1_type && (
            <SearchableInfoSelect
              items={infoCache[inBi.info_1_type]}
              value={form.in_info_1_id}
              onChange={(val) => setForm({...form, in_info_1_id: val})}
              label={`${INFO_LABELS[inBi.info_1_type]} (${inBi.code})`}
              infoType={inBi.info_1_type}
              onItemCreated={handleItemCreated}
            />
          )}
          {inBi?.info_2_type && (
            <SearchableInfoSelect
              items={infoCache[inBi.info_2_type]}
              value={form.in_info_2_id}
              onChange={(val) => setForm({...form, in_info_2_id: val})}
              label={`${INFO_LABELS[inBi.info_2_type]} (${inBi.code})`}
              infoType={inBi.info_2_type}
              onItemCreated={handleItemCreated}
            />
          )}

          {/* Кредит */}
          <div>
            <label className={lc}>Кредит (откуда)</label>
            <select value={form.out_bi_id}
              onChange={e => {
                setForm({...form, out_bi_id: e.target.value, out_info_1_id: '', out_info_2_id: ''})
                loadInfoForBi(e.target.value, infoCache)
              }}
              className={ic} required>
              <option value="">Выберите счёт...</option>
              {balanceItems.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}
            </select>
          </div>

          {outBi?.info_1_type && (
            <SearchableInfoSelect
              items={infoCache[outBi.info_1_type]}
              value={form.out_info_1_id}
              onChange={(val) => setForm({...form, out_info_1_id: val})}
              label={`${INFO_LABELS[outBi.info_1_type]} (${outBi.code})`}
              infoType={outBi.info_1_type}
              onItemCreated={handleItemCreated}
            />
          )}
          {outBi?.info_2_type && (
            <SearchableInfoSelect
              items={infoCache[outBi.info_2_type]}
              value={form.out_info_2_id}
              onChange={(val) => setForm({...form, out_info_2_id: val})}
              label={`${INFO_LABELS[outBi.info_2_type]} (${outBi.code})`}
              infoType={outBi.info_2_type}
              onItemCreated={handleItemCreated}
            />
          )}
           
          {/* Содержание */}
          <div>
           <label className={lc}>Содержание</label>
            <input
            type="text"
              value={form.content ?? ''}
              onChange={e => setForm({...form, content: e.target.value})}
              placeholder="Назначение платежа, описание проводки"
              className={ic}
          />
          </div>

          <div>
            <label className={lc}>Комментарий</label>
            <input type="text" value={form.note}
              onChange={e => setForm({...form, note: e.target.value})}
              placeholder="Необязательно" className={ic} />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onCancel}
              className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
              Отмена
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 px-4 py-2.5 bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50 text-sm font-medium">
              {loading ? 'Сохранение...' : isEdit ? 'Обновить' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
