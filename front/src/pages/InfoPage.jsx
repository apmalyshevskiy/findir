import { useState, useEffect } from 'react'
import { getInfo, createInfo, updateInfo, deleteInfo } from '../api/info'
import Layout from '../components/Layout'
import DictionaryTemplatePicker from '../components/DictionaryTemplatePicker'
import InfoTypeBadge from '../components/InfoTypeBadge'
import InfoSelect from '../components/InfoSelect'
import BulkEditInfo from '../components/BulkEditInfo'
import InfoReferencesModal from '../components/InfoReferencesModal'
import ObjectHistory from '../components/ObjectHistory'
import { matchesSearch, Highlight } from '../utils/infoSearch'
import { EXPENSE_KINDS, EXPENSE_KIND_HINT, FLOW_KINDS, FLOW_KIND_HINT } from '../utils/infoLabels'
import { pushRecent } from '../utils/recent'
import { BookOpen, Check, ChevronRight, Link2, Pencil, Plus, Search, Trash2, Wand2, X } from 'lucide-react'
import { apiError, confirm, toast, useEscClose, Button, EmptyState, IconButton, PageHeader } from '../components/ui'
import { SkeletonRows } from '../components/Busy'

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

const emptyForm = { name: '', type: 'partner', code: '', description: '', inn: '', parent_id: '', sort_order: 0, default_expense_id: '', expense_kind: 'fixed', flow_kind: 'operating' }

/**
 * Выбор элемента справочника: родитель и статья расхода по умолчанию.
 *
 * Список, поиск, недавние и создание — в общем компоненте, одном на все
 * экраны. Здесь остались только подписи: у родителя пустое значение
 * называется «Без родителя», у статьи расхода — «Не выбрана».
 */
const InfoPicker = ({ items, value, onChange, infoType, onItemCreated,
                      label = 'Родитель', hint = '', emptyLabel = '— Без родителя' }) => (
  <InfoSelect
    items={items}
    value={value}
    onChange={onChange}
    infoType={infoType}
    onItemCreated={onItemCreated}
    label={label}
    hint={hint}
    emptyLabel={emptyLabel}
    placeholder={emptyLabel}
  />
)

export default function InfoPage() {
  const [items, setItems] = useState([])
  const [filterType, setFilterType] = useState('')
  const [search, setSearch] = useState('')
  const [expandedByType, setExpandedByType] = useState({})
  const [showForm, setShowForm] = useState(false)
  useEscClose(() => setShowForm(false), showForm)
  const [editItem, setEditItem] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expenseOptions, setExpenseOptions] = useState([])
  const [copiedId, setCopiedId] = useState(null)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // Выбранные для массовой правки. Живут в пределах одного справочника:
  // родитель и вид у разных справочников разные, и общей правки для них нет
  const [picked, setPicked] = useState(() => new Set())
  const [showBulk, setShowBulk] = useState(false)
  // Элемент, для которого смотрим ссылки. Считаем по требованию: узнать это
  // для каждой строки списка — десятки запросов ради цифры, которую не просили
  const [refsFor, setRefsFor] = useState(null)

  useEffect(() => { loadItems() }, [filterType])

  // Сменили справочник или начали искать — выделение снимаем: оно относилось
  // к тому, что было на экране
  useEffect(() => { setPicked(new Set()) }, [filterType])

  const togglePick = (id) => setPicked(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  /**
   * Открыть элемент по ссылке `?open=123` — из журнала изменений и недавних.
   *
   * Ждём список: форма правки заполняется из самого элемента, а искать его
   * отдельным запросом ради этого незачем — справочник и так уже загружен.
   */
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('open'))
    if (!id || !items.length) return

    const item = items.find(i => Number(i.id) === id)
    if (item) openEdit(item)

    window.history.replaceState({}, '', '/info')
  }, [items])

  // Список статей расходов для выпадашки «Статья расходов по умолчанию» (тип flow).
  // Грузим при каждом открытии формы — список items при активном фильтре по типу
  // может не содержать расходов.
  useEffect(() => {
    if (showForm) {
      getInfo({ type: 'expenses' })
        .then(res => setExpenseOptions(res.data.data || []))
        .catch(() => {})
    }
  }, [showForm])

  const copyId = (id) => {
    navigator.clipboard?.writeText(String(id))
    setCopiedId(id)
    setTimeout(() => setCopiedId(c => (c === id ? null : c)), 1200)
  }

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
    setShowHistory(false)   // у нового элемента своя история, старую не показываем
    pushRecent('info', item.id, item.name)
    setForm({
      name:        item.name,
      type:        item.type,
      code:        item.code || '',
      description: item.description || '',
      inn:         item.inn || '',
      parent_id:   item.parent_id || '',
      sort_order:  item.sort_order || 0,
      default_expense_id: item.default_expense_id || '',
      expense_kind: item.expense_kind || 'fixed',
      flow_kind:    item.flow_kind || 'operating',
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
      code:       form.code || null,
      inn:        form.inn || null,
      parent_id:  form.parent_id || null,
      sort_order: form.sort_order,
      description: form.description || null,
      default_expense_id: form.default_expense_id || null,
      // Вид держим только у статей расхода: у контрагента или кассы он
      // бессмыслен, а оставленный от прежнего типа сбил бы БДР
      expense_kind: form.type === 'expenses' ? (form.expense_kind || 'fixed') : 'fixed',
      flow_kind:    form.type === 'flow' ? (form.flow_kind || 'operating') : 'operating',
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
    if (!await confirm({ title: 'Удалить запись?', danger: true })) return
    // Сервер отказывает, если запись используется в операциях. Раньше отказ
    // пропадал молча: нажал «Удалить», запись осталась, почему — неизвестно
    try {
      await deleteInfo(id)
      toast.success('Запись удалена')
      loadItems()
    } catch (err) {
      toast.error(apiError(err, 'Не удалось удалить запись'))
    }
  }

  const toggleExpand = (type, id) => {
    setExpandedByType(prev => {
      const set = new Set(prev[type] || [])
      set.has(id) ? set.delete(id) : set.add(id)
      return { ...prev, [type]: set }
    })
  }

  const ic = "w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"

  const searching = search.trim().length > 0
  const found = searching ? items.filter(i => matchesSearch(i, search)) : items

  const grouped = filterType
    ? (found.length > 0 ? { [filterType]: found } : {})
    : INFO_TYPES.reduce((acc, t) => {
        const f = found.filter(i => i.type === t.value)
        if (f.length > 0) acc[t.value] = f
        return acc
      }, {})

  /**
   * Путь до родителя — «Расходы › Аренда».
   *
   * В поиске дерево разворачивается в плоский список, и без пути непонятно,
   * та ли это «Аренда»: одноимённые статьи в разных ветках — обычное дело.
   */
  const parentPath = (item) => {
    const byId = Object.fromEntries(items.map(i => [i.id, i]))
    const path = []
    let cur = byId[item.parent_id]
    while (cur && path.length < 4) {
      path.unshift(cur.name)
      cur = byId[cur.parent_id]
    }
    return path.join(' › ')
  }

  return (
    <Layout>
      <PageHeader title="Справочники"
        subtitle="Контрагенты, статьи, кассы, сотрудники — всё, чем подписываются операции"
        actions={<>
          <Button icon={Wand2} onClick={() => setShowTemplates(true)}>Заполнить из шаблона</Button>
          <Button variant="primary" icon={Plus} onClick={openCreate}>Добавить запись</Button>
        </>} />

      {/* Поиск: по названию, коду, ИНН, описанию и номеру */}
      <div className="relative mb-4 max-w-md">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setSearch('') }}
          placeholder="Поиск: название, код, ИНН, описание, #номер"
          className="w-full h-9 pl-9 pr-9 bg-white border border-gray-200 rounded-lg text-sm hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500"
        />
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
        {searching && (
          <IconButton icon={X} size="sm" label="Очистить (Esc)" onClick={() => setSearch('')}
            className="absolute right-1 top-1/2 -translate-y-1/2" />
        )}
      </div>

      {searching && (
        <div className="text-xs text-gray-500 mb-4">
          {found.length === 0
            ? 'Ничего не найдено'
            : `Найдено: ${found.length} — показаны списком, без вложенности`}
        </div>
      )}

      {/* Фильтр по типу */}
      <div className="flex gap-1.5 flex-wrap mb-5">
        <button onClick={() => setFilterType('')}
          className={`h-8 px-3 rounded-full text-sm font-medium border transition-colors ${filterType === '' ? 'bg-brand-800 border-brand-800 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-brand-300 hover:text-brand-700'}`}>
          Все
        </button>
        {INFO_TYPES.map(t => (
          <button key={t.value} onClick={() => setFilterType(t.value)}
            className={`h-8 px-3 rounded-full text-sm font-medium border transition-colors ${filterType === t.value ? 'bg-brand-800 border-brand-800 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-brand-300 hover:text-brand-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Массовая правка — только внутри одного справочника: родитель из
          чужого справочника сломал бы дерево, а вид есть не у всех */}
      {picked.size > 0 && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2.5 bg-gold-50 border border-gold-200 rounded-xl">
          <span className="text-sm text-gold-900 font-medium">Отмечено: {picked.size}</span>
          <Button size="sm" variant="primary" icon={Pencil} onClick={() => setShowBulk(true)}>Изменить отмеченные</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Снять отметки</Button>
        </div>
      )}

      {/* Список */}
      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-4"><SkeletonRows rows={8} height="h-9" /></div>
      ) : searching && found.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200/80 shadow-card">
          <EmptyState icon={Search} title={`По запросу «${search}» ничего нет`}
            text="Ищем по названию, коду, ИНН, описанию и номеру записи"
            action={<Button onClick={() => setSearch('')}>Очистить поиск</Button>} />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200/80 shadow-card">
          <EmptyState icon={BookOpen} title="Справочники пока пустые"
            text="Набор статей зависит от бизнеса, поэтому при регистрации мы ничего не навязываем. Возьмите готовый шаблон и правьте под себя — или заводите записи вручную."
            action={<Button variant="primary" icon={Wand2} onClick={() => setShowTemplates(true)}>Заполнить из шаблона</Button>} />
        </div>
      ) : (
        Object.entries(grouped).map(([type, typeItems]) => {
          const typeLabel = INFO_TYPES.find(t => t.value === type)?.label || type
          const expandedSet = expandedByType[type] || new Set()
          // В поиске дерево не строим: найденная ветка может лежать глубоко, и
          // раскрывать её вручную ради одной статьи — лишняя работа
          const flat = searching
            ? typeItems.map(i => ({ ...i, depth: 0, children: [] }))
            : flattenTree(buildTree(typeItems), 0, expandedSet)

          return (
            <div key={type} className="bg-white rounded-xl border border-gray-200/80 shadow-card mb-4 overflow-hidden">
              <div className="px-6 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  {/* Отмечать можно, только когда на экране один справочник:
                      массовая правка работает внутри одного вида */}
                  {filterType && (
                    <input type="checkbox" title="Выбрать все показанные"
                      className="w-4 h-4 rounded border-gray-300 accent-brand-700"
                      checked={flat.length > 0 && flat.every(i => picked.has(i.id))}
                      onChange={e => setPicked(prev => {
                        const next = new Set(prev)
                        flat.forEach(i => e.target.checked ? next.add(i.id) : next.delete(i.id))
                        return next
                      })} />
                  )}
                  {typeLabel}
                </span>
                <span className="text-xs text-gray-500 tabular-nums">
                  {searching
                    ? `${typeItems.length} из ${items.filter(i => i.type === type).length}`
                    : typeItems.length}
                </span>
              </div>
              <table className="w-full">
                <tbody>
                  {flat.map(item => (
                    <tr key={item.id}
                      className={`border-b border-gray-50 last:border-0 hover:bg-gray-50 group ${
                        picked.has(item.id) ? 'bg-gold-50/70' : ''
                      }`}>
                      {filterType && (
                        <td className="py-2.5 pl-6 w-8">
                          <input type="checkbox"
                            className="w-4 h-4 rounded border-gray-300 accent-brand-700"
                            checked={picked.has(item.id)} onChange={() => togglePick(item.id)} />
                        </td>
                      )}
                      <td className="py-2.5 pr-4">
                        {/* Слева уже стоит колонка с галочкой — отступ ей не нужен */}
                        <div className="flex items-center" style={{ paddingLeft: `${(filterType ? 4 : 24) + item.depth * 20}px` }}>
                          <div className="w-5 flex items-center justify-center flex-shrink-0 mr-1.5">
                            {item.children?.length > 0 ? (
                              <button onClick={() => toggleExpand(type, item.id)}
                                aria-label={expandedSet.has(item.id) ? 'Свернуть' : 'Раскрыть'}
                                className="text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors p-0.5">
                                <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-200 ${expandedSet.has(item.id) ? 'rotate-90' : ''}`} aria-hidden="true" />
                              </button>
                            ) : item.depth > 0 ? (
                              <span className="text-gray-300 text-xs">└</span>
                            ) : null}
                          </div>
                          <span className="text-sm text-gray-800">
                            <Highlight text={item.name} q={search} />
                          </span>
                          {/* Тип — стикером у каждой строки: заголовок группы
                              уезжает при прокрутке, а «Аренда» без типа может
                              оказаться и расходом, и статьёй ДДС */}
                          <InfoTypeBadge type={item.type} className="ml-2" />
                          {/* В поиске дерева не видно — показываем, где элемент лежит */}
                          {searching && parentPath(item) && (
                            <span className="ml-2 text-xs text-gray-400 truncate">{parentPath(item)}</span>
                          )}
                          {/* Показываем ИНН для partner */}
                          {item.type === 'partner' && item.inn && (
                            <span className="ml-2 text-xs text-gray-400">
                              ИНН: <Highlight text={item.inn} q={search} />
                            </span>
                          )}
                          {/* Описание — только когда нашли по нему: иначе оно
                              загромождало бы обычный список */}
                          {searching && item.description &&
                            String(item.description).toLowerCase().includes(search.trim().toLowerCase()) && (
                            <span className="ml-2 text-xs text-gray-400 truncate">
                              <Highlight text={item.description} q={search} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 whitespace-nowrap">
                        <button type="button" onClick={() => copyId(item.id)} title="Скопировать ID"
                          className="inline-flex items-center gap-1 text-2xs font-mono text-gray-400 hover:text-brand-700">
                          {copiedId === item.id ? <><Check className="w-3 h-3 text-emerald-600" aria-hidden="true" />скопировано</> : `#${item.id}`}
                        </button>
                      </td>
                      <td className="py-2.5 pr-4">
                        {item.code && (
                          <span className="text-xs font-mono bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
                            <Highlight text={item.code} q={search} />
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-6 text-right">
                        <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex gap-0.5 justify-end">
                          <IconButton icon={Pencil} size="sm" label="Изменить" onClick={() => openEdit(item)} />
                          <IconButton icon={Link2} size="sm" label="Где используется" onClick={() => setRefsFor(item)} />
                          <IconButton icon={Trash2} size="sm" variant="danger" label="Удалить" onClick={() => handleDelete(item.id)} />
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

      {/* Где используется элемент */}
      {refsFor && (
        <InfoReferencesModal id={refsFor.id} name={refsFor.name} onClose={() => setRefsFor(null)} />
      )}

      {/* Массовая правка выбранных */}
      {showBulk && (
        <BulkEditInfo
          ids={[...picked]}
          type={filterType}
          items={items.filter(i => i.type === filterType)}
          onClose={() => setShowBulk(false)}
          onApplied={() => { setPicked(new Set()); loadItems() }}
        />
      )}

      {/* Шаблоны наполнения */}
      {showTemplates && (
        <DictionaryTemplatePicker
          onClose={() => setShowTemplates(false)}
          onApplied={loadItems}
        />
      )}

      {/* Форма */}
      {showForm && (
        <div className="fixed inset-0 bg-brand-950/40 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-pop w-full max-w-md animate-pop-in">
            <div className="px-6 pt-5 pb-4 border-b border-gray-100 flex justify-between items-start gap-3">
              <h3 className="text-base font-semibold text-gray-900">
                {editItem ? 'Изменить запись' : 'Новая запись'}
              </h3>
              <IconButton icon={X} label="Закрыть (Esc)" onClick={() => setShowForm(false)} className="-mr-2 -mt-1" />
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

              {/* ID — только при редактировании, нередактируемый, с копированием */}
              {editItem && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ID</label>
                  <div className="flex items-center gap-2">
                    <input type="text" value={editItem.id} readOnly
                      className={ic + ' font-mono bg-gray-50 text-gray-500'} />
                    <button type="button" onClick={() => copyId(editItem.id)}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 whitespace-nowrap">
                      {copiedId === editItem.id ? 'Скопировано ✓' : 'Копировать'}
                    </button>
                  </div>
                </div>
              )}

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
              <InfoPicker
                items={items.filter(i => i.type === form.type && i.id !== editItem?.id)}
                value={form.parent_id}
                onChange={val => setForm({ ...form, parent_id: val })}
                infoType={form.type}
                onItemCreated={(newItem) => setItems(prev => [...prev, newItem])}
              />

              {/* Название */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Название</label>
                <input type="text" value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Название" className={ic} required autoFocus />
              </div>

              {/* Код */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Код
                  <span className="ml-1 text-xs text-gray-400 font-normal">необязательно</span>
                </label>
                <input type="text" value={form.code}
                  onChange={e => setForm({ ...form, code: e.target.value })}
                  placeholder="SALES" className={ic + ' font-mono'}
                  maxLength={35} />
              </div>

              {/* Статья расходов по умолчанию — только для flow.
                  Тем же компонентом, что и родитель: нужной статьи расхода
                  может ещё не быть, и заводить её надо здесь же, не выходя
                  из карточки статьи ДДС */}
              {form.type === 'flow' && (
                <InfoPicker
                  label="Статья расходов по умолчанию"
                  hint="для автозаполнения выписки"
                  emptyLabel="— Не выбрана"
                  items={expenseOptions}
                  value={form.default_expense_id}
                  onChange={val => setForm({ ...form, default_expense_id: val })}
                  infoType="expenses"
                  // Кладём только в список статей расхода: общий список страницы
                  // отфильтрован по типу, и расходу среди статей ДДС не место.
                  // Страница перечитается сама после сохранения формы
                  onItemCreated={(newItem) => setExpenseOptions(prev => [...prev, newItem])}
                />
              )}

              {/* Вид расхода — только у статьи расхода. По нему БДР раскладывает
                  расходы на группы и считает промежуточные прибыли; на проводки
                  и на остальные отчёты он не влияет */}
              {form.type === 'expenses' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Вид расхода</label>
                  <select
                    value={form.expense_kind || 'fixed'}
                    onChange={e => setForm({ ...form, expense_kind: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm">
                    {EXPENSE_KINDS.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    {EXPENSE_KIND_HINT[form.expense_kind || 'fixed']}
                  </p>
                </div>
              )}

              {/* Вид деятельности — только у статьи ДДС. По нему ОДДС
                  раскладывает движение денег на три раздела; на проводки и на
                  остальные отчёты он не влияет */}
              {form.type === 'flow' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Вид деятельности</label>
                  <select
                    value={form.flow_kind || 'operating'}
                    onChange={e => setForm({ ...form, flow_kind: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm">
                    {FLOW_KINDS.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    {FLOW_KIND_HINT[form.flow_kind || 'operating']}
                  </p>
                </div>
              )}

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
                <p className="text-2xs text-gray-400 mt-1">Меньше число — выше в списке</p>
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

              {/* Свёрнута: карточку открывают, чтобы поправить, а не читать
                  прошлое. Но раньше здесь истории не было вовсе — она жила
                  только в карточке из выпадающих списков */}
              {editItem && (
                <div className="pt-3 border-t border-gray-100 space-y-2">
                  <div className="flex items-center gap-4">
                    {!showHistory && (
                      <button type="button" onClick={() => setShowHistory(true)}
                        className="text-xs text-blue-700 hover:underline">
                        История изменений
                      </button>
                    )}
                    {/* Рядом с историей нарочно: сюда приходят, когда карточка
                        не даёт сменить справочник, — и первый вопрос «а кто
                        держит?» */}
                    <button type="button" onClick={() => setRefsFor(editItem)}
                      className="text-xs text-blue-700 hover:underline">
                      Где используется
                    </button>
                  </div>
                  {showHistory && (
                    <ObjectHistory entity="info" id={editItem.id}
                      /* Закрываем и перечитываем: в полях формы остались
                         прежние значения, сохранение затёрло бы возврат */
                      onRestored={() => { setShowForm(false); loadItems() }} />
                  )}
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </Layout>
  )
}
