import { useState, useEffect } from 'react'
import { getBalanceItems, createOperation, updateOperation } from '../api/operations'
import { getInfo, createInfo, updateInfo } from '../api/info'
import { getProjects } from '../api/projects'
import AmountInput from './AmountInput'

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

// Стили полей карточки справочника
const fc = 'w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const fl = 'block text-[11px] text-gray-500 mb-0.5'

// Полный набор реквизитов элемента справочника
const EMPTY_INFO = {
  name: '', code: '', parent_id: '', inn: '', description: '',
  sort_order: 0, is_active: true, default_expense_id: '',
}

// 2. Кастомный компонент селекта с поиском, иерархией, inline-созданием и редактированием
const SearchableInfoSelect = ({ items, value, onChange, label, infoType, onItemCreated }) => {
  const [search, setSearch] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  // mode: null | 'create' | 'edit'
  const [formMode, setFormMode] = useState(null)
  const [editId, setEditId] = useState(null)
  const [fields, setFields] = useState({ ...EMPTY_INFO })
  const [expenseOpts, setExpenseOpts] = useState([])   // для статей ДДС: статья расхода по умолчанию
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Статьи расхода нужны только при редактировании статьи ДДС
  useEffect(() => {
    if (formMode && infoType === 'flow' && expenseOpts.length === 0) {
      getInfo({ type: 'expenses' }).then(r => setExpenseOpts(r.data.data || [])).catch(() => {})
    }
  }, [formMode, infoType])

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
    setFields({ ...EMPTY_INFO })
    setError('')
  }

  /** Реквизиты → payload API (пустые строки превращаем в null) */
  const payload = () => ({
    name:               fields.name.trim(),
    type:               infoType,
    code:               fields.code?.trim() || null,
    description:        fields.description?.trim() || null,
    inn:                fields.inn?.trim() || null,
    parent_id:          fields.parent_id || null,
    sort_order:         parseInt(fields.sort_order) || 0,
    default_expense_id: fields.default_expense_id || null,
  })

  const handleCreate = async () => {
    if (!fields.name.trim() || !infoType) return
    setSaving(true); setError('')
    try {
      const res = await createInfo(payload())
      const created = res.data.data
      if (onItemCreated) onItemCreated(infoType, created)
      onChange(created.id)
      resetForm()
      setSearch('')
      setIsOpen(false)
    } catch (err) {
      setError(err?.response?.data?.message || 'Не удалось создать элемент')
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async () => {
    if (!fields.name.trim() || !editId) return
    setSaving(true); setError('')
    try {
      const res = await updateInfo(editId, { ...payload(), is_active: !!fields.is_active })
      const updated = res.data.data
      // Обновляем элемент в кеше
      if (onItemCreated) onItemCreated(infoType, updated, editId)
      resetForm()
      setSearch('')
      setIsOpen(false)
    } catch (err) {
      setError(err?.response?.data?.message || 'Не удалось сохранить изменения')
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (e) => {
    e.stopPropagation()
    if (!selectedOption) return
    setFormMode('edit')
    setEditId(selectedOption.id)
    setFields({
      name:               selectedOption.name || '',
      code:               selectedOption.code || '',
      parent_id:          selectedOption.parent_id || '',
      inn:                selectedOption.inn || '',
      description:        selectedOption.description || '',
      sort_order:         selectedOption.sort_order ?? 0,
      is_active:          selectedOption.is_active ?? true,
      default_expense_id: selectedOption.default_expense_id || '',
    })
    setError('')
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
            placeholder={selectedOption ? '' : "Выберите значение..."}
            value={search}
            onFocus={() => { setIsOpen(true); if (formMode === 'edit') resetForm() }}
            onChange={(e) => {
              setSearch(e.target.value)
              setIsOpen(true)
              resetForm()
            }}
          />
          {selectedOption && !search && (
            <div className="absolute inset-y-0 left-0 right-0 flex items-center px-3 text-sm text-gray-900 pointer-events-none truncate">
              {selectedOption.name}
            </div>
          )}
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
        {/* Выпадающий список (прячется, пока открыта карточка справочника) */}
        {isOpen && !formMode && (
          <div className="absolute left-0 right-0 top-full z-[60] mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-y-auto max-h-72">
            {(
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
                )) : <div className="px-3 py-2 text-sm text-gray-400">Ничего не найдено</div>}

                {/* Кнопка создания */}
                {infoType && (
                  <div
                    className="px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 cursor-pointer border-t border-gray-100 flex items-center gap-1.5"
                    onClick={(e) => {
                      e.stopPropagation()
                      setFormMode('create')
                      setEditId(null)
                      setFields({ ...EMPTY_INFO, name: search })
                      setError('')
                    }}
                  >
                    <span className="text-blue-500">+</span> Создать «{search || INFO_LABELS[infoType] || infoType}»
                  </div>
                )}
              </>
            )}

          </div>
        )}
      </div>

      {/* Карточка справочника — отдельным окном по центру, чтобы не уезжала за экран */}
      {formMode && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={resetForm}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[88vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white">
              <h4 className="text-sm font-semibold text-gray-800">
                {formMode === 'edit'
                  ? `${INFO_LABELS[infoType] || infoType}: ${selectedOption?.name || ''}`
                  : `Новый элемент: ${INFO_LABELS[infoType] || infoType}`}
              </h4>
              <button type="button" onClick={resetForm}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">&times;</button>
            </div>

            <div className="p-4 space-y-3">
                {/* Наименование */}
                <div>
                  <span className={fl}>Наименование</span>
                  <input
                    type="text"
                    className={fc}
                    placeholder="Название элемента справочника"
                    value={fields.name}
                    onChange={e => setFields(f => ({ ...f, name: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); formMode === 'edit' ? handleUpdate() : handleCreate() }
                      if (e.key === 'Escape') resetForm()
                    }}
                    autoFocus
                  />
                </div>
                <div>
                <span className={fl}>Родительская группа</span>
                <select
                  className={`${fc} text-gray-700`}
                  value={fields.parent_id}
                  onChange={e => setFields(f => ({ ...f, parent_id: e.target.value }))}
                >
                  <option value="">— Без родителя (верхний уровень)</option>
                  {flatItems.filter(o => o.id != editId).map(opt => (
                    <option key={opt.id} value={opt.id}>
                      {'\u00A0'.repeat(opt.depth * 2)}{opt.depth > 0 ? '└ ' : ''}{opt.name}
                    </option>
                  ))}
                </select>
                </div>

                {/* ИНН — только для контрагентов */}
                {infoType === 'partner' && (
                  <div>
                    <span className={fl}>ИНН</span>
                    <input type="text" className={fc} placeholder="10 или 12 цифр" maxLength={12}
                      value={fields.inn}
                      onChange={e => setFields(f => ({ ...f, inn: e.target.value.replace(/\D/g, '') }))} />
                  </div>
                )}

                {/* Статья расхода по умолчанию — только для статей ДДС */}
                {infoType === 'flow' && (
                  <div>
                    <span className={fl}>Статья расхода по умолчанию</span>
                    <select className={`${fc} text-gray-700`} value={fields.default_expense_id}
                      onChange={e => setFields(f => ({ ...f, default_expense_id: e.target.value }))}>
                      <option value="">— не задана</option>
                      {expenseOpts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                    <span className="block text-[10px] text-gray-400 mt-0.5">
                      Подставится в операцию при выборе этой статьи ДДС
                    </span>
                  </div>
                )}

                {/* Описание */}
                <div>
                  <span className={fl}>Описание</span>
                  <textarea rows={2} className={fc} placeholder="Необязательно"
                    value={fields.description}
                    onChange={e => setFields(f => ({ ...f, description: e.target.value }))} />
                </div>

                {/* Код + порядок сортировки + активность */}
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="w-32">
                    <span className={fl}>Код</span>
                    <input type="text" className={fc} placeholder="—"
                      value={fields.code} onChange={e => setFields(f => ({ ...f, code: e.target.value }))} />
                  </div>
                  <div className="w-24">
                    <span className={fl}>Порядок</span>
                    <input type="number" step="1" className={fc}
                      value={fields.sort_order}
                      onChange={e => setFields(f => ({ ...f, sort_order: e.target.value }))} />
                  </div>
                  {formMode === 'edit' && (
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 mt-4">
                      <input type="checkbox" className="rounded" checked={!!fields.is_active}
                        onChange={e => setFields(f => ({ ...f, is_active: e.target.checked }))} />
                      Активен
                    </label>
                  )}
                </div>

                {error && <div className="text-xs text-red-600">{error}</div>}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={formMode === 'edit' ? handleUpdate : handleCreate}
                    disabled={!fields.name.trim() || saving}
                    className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? '...' : formMode === 'edit' ? 'Сохранить' : 'Создать'}
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="px-4 py-2 text-gray-500 hover:text-gray-700 text-sm border border-gray-200 rounded-lg"
                  >
                    Отмена
                  </button>
                </div>
            </div>
          </div>
        </div>
      )}

      {isOpen && !formMode && <div className="fixed inset-0 z-[55]" onClick={() => { setIsOpen(false); resetForm() }}></div>}
    </div>
  )
}

// `operation` — редактирование существующей; `initial` — предзаполнение новой (черновик ИИ)
export default function OperationForm({ operation, initial, onSuccess, onCancel }) {
  const isEdit = !!(operation && operation.id)
  const src = operation || initial || null
  const [balanceItems, setBalanceItems] = useState([])
  const [projects, setProjects] = useState([])
  const [infoCache, setInfoCache] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Режим формы: 'classic' (в столбик) | 'wide' (дебет/кредит рядом). Запоминаем выбор.
  const [layout, setLayout] = useState(() => localStorage.getItem('op_form_layout') || 'wide')
  const changeLayout = (v) => { setLayout(v); localStorage.setItem('op_form_layout', v) }
  // Локальное время для datetime-local input без UTC-конвертации
  const localNow = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  // Черновик ИИ приходит с датой без времени (YYYY-MM-DD) — дополняем текущим временем
  const toLocalInput = (d) => {
    if (!d) return localNow()
    const s = String(d).replace(' ', 'T')
    return s.length <= 10 ? `${s}T${localNow().slice(11)}` : s.slice(0, 16)
  }

  const [form, setForm] = useState({
    date:          src ? toLocalInput(src.date) : localNow(),
    project_id:    src?.project_id ?? '',
    amount:        src?.amount ?? '',
    in_bi_id:      src?.in_bi_id ?? '',
    out_bi_id:     src?.out_bi_id ?? '',
    in_info_1_id:  src?.in_info_1_id ?? '',
    in_info_2_id:  src?.in_info_2_id ?? '',
    out_info_1_id: src?.out_info_1_id ?? '',
    out_info_2_id: src?.out_info_2_id ?? '',
    content:       src?.content ?? '',
    note:          src?.note ?? '',
    // Новая операция проводится сразу — иначе её пришлось бы проводить
    // вторым действием, а это норма, а не исключение
    is_posted:     src ? src.is_posted !== false : true,

    })

  useEffect(() => {
    getProjects().then(res => {
      const list = res.data.data || []
      setProjects(list)
      // При создании операции — подставляем первый проект, если ещё не выбран.
      if (!isEdit && list.length > 0) {
        setForm(f => (f.project_id ? f : { ...f, project_id: list[0].id }))
      }
    })

    getBalanceItems().then(res => {
      const items = res.data.data
      setBalanceItems(items)

      if (src) {
        const inBi  = items.find(b => b.id == src.in_bi_id)
        const outBi = items.find(b => b.id == src.out_bi_id)
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
      const payload = { ...form }
      if (payload.date) {
        // Дата операции хранится и сравнивается как локальная «настенная»:
        // такой её пишет импорт выписки, по такой фильтрует список и по такой
        // же проверяется запрет закрытого периода. Перевод в UTC здесь сдвигал
        // операцию на смещение пояса — у полуночных строк из выписки на сутки
        // назад, вплоть до попадания в закрытый период. Отдаём как есть.
        const s = String(payload.date).replace('T', ' ')
        payload.date = s.length === 16 ? `${s}:00` : s.slice(0, 19)
      }
      isEdit ? await updateOperation(operation.id, payload) : await createOperation(payload)
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

  const debitFields = (
    <>
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
        <SearchableInfoSelect items={infoCache[inBi.info_1_type]} value={form.in_info_1_id}
          onChange={(val) => setForm({...form, in_info_1_id: val})}
          label={`${INFO_LABELS[inBi.info_1_type]} (${inBi.code})`} infoType={inBi.info_1_type} onItemCreated={handleItemCreated} />
      )}
      {inBi?.info_2_type && (
        <SearchableInfoSelect items={infoCache[inBi.info_2_type]} value={form.in_info_2_id}
          onChange={(val) => setForm({...form, in_info_2_id: val})}
          label={`${INFO_LABELS[inBi.info_2_type]} (${inBi.code})`} infoType={inBi.info_2_type} onItemCreated={handleItemCreated} />
      )}
    </>
  )

  const creditFields = (
    <>
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
        <SearchableInfoSelect items={infoCache[outBi.info_1_type]} value={form.out_info_1_id}
          onChange={(val) => setForm({...form, out_info_1_id: val})}
          label={`${INFO_LABELS[outBi.info_1_type]} (${outBi.code})`} infoType={outBi.info_1_type} onItemCreated={handleItemCreated} />
      )}
      {outBi?.info_2_type && (
        <SearchableInfoSelect items={infoCache[outBi.info_2_type]} value={form.out_info_2_id}
          onChange={(val) => setForm({...form, out_info_2_id: val})}
          label={`${INFO_LABELS[outBi.info_2_type]} (${outBi.code})`} infoType={outBi.info_2_type} onItemCreated={handleItemCreated} />
      )}
    </>
  )

  const contentField = (
    <div>
      <label className={lc}>Содержание</label>
      <input type="text" value={form.content ?? ''} onChange={e => setForm({...form, content: e.target.value})}
        placeholder="Назначение платежа, описание проводки" className={ic} />
    </div>
  )

  const commentField = (
    <div>
      <label className={lc}>Комментарий</label>
      <input type="text" value={form.note} onChange={e => setForm({...form, note: e.target.value})}
        placeholder="Необязательно" className={ic} />
    </div>
  )

  const postingField = (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="checkbox" className="w-4 h-4 accent-blue-900 mt-0.5"
        checked={form.is_posted !== false}
        onChange={e => setForm({ ...form, is_posted: e.target.checked })} />
      <span>
        <span className="text-sm text-gray-700">Проведена</span>
        <span className="block text-[11px] text-gray-400">
          Непроведённая операция остаётся в списке, но не попадает в обороты и отчёты
        </span>
      </span>
    </label>
  )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className={`bg-white rounded-2xl shadow-xl w-full my-4 ${layout === 'wide' ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="p-6 border-b border-gray-100 flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-gray-800">
            {isEdit ? 'Редактировать операцию' : 'Новая операция'}
          </h3>
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 text-xs flex-shrink-0">
            <button type="button" onClick={() => changeLayout('classic')}
              className={`px-2.5 py-1 rounded-md transition-colors ${layout === 'classic' ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-700'}`}>
              В столбик
            </button>
            <button type="button" onClick={() => changeLayout('wide')}
              className={`px-2.5 py-1 rounded-md transition-colors ${layout === 'wide' ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-700'}`}>
              Рядом
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

          {projects.length > 1 && (
            <div>
              <label className={lc}>Проект</label>
              <select value={form.project_id}
                onChange={e => setForm({...form, project_id: e.target.value})}
                className={ic} required>
                <option value="">Выберите проект...</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lc}>Дата и время</label>
              <input type="datetime-local" value={form.date}
                onChange={e => setForm({...form, date: e.target.value})}
                className={ic} required />
            </div>
            <div>
              <label className={lc}>Сумма (₽)</label>
              <AmountInput value={form.amount}
                onChange={v => setForm({...form, amount: v})}
                placeholder="0,00" className={`${ic} text-right`} required />
            </div>
          </div>

          {/* Содержание — вверху на всю ширину (только в режиме «рядом») */}
          {layout === 'wide' && contentField}

          {/* Дебет / Кредит — рядом (wide) или в столбик (classic) */}
          {layout === 'wide' ? (
            <div className="grid grid-cols-2 border border-gray-200 rounded-xl">
              <div className="p-4 space-y-3 border-r border-gray-200 bg-green-50/40 rounded-l-xl">{debitFields}</div>
              <div className="p-4 space-y-3 bg-red-50/30 rounded-r-xl">{creditFields}</div>
            </div>
          ) : (
            <div className="space-y-4">{debitFields}{creditFields}</div>
          )}

          {/* Комментарий (рядом) / Содержание+Комментарий (в столбик) */}
          {layout === 'wide' ? commentField : (
            <div className="space-y-4">{contentField}{commentField}</div>
          )}

          {postingField}

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
