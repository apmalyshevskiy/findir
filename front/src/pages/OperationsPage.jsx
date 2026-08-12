import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { getOperations, deleteOperation, getBalanceItems, createOperation, setOperationPosting } from '../api/operations'
import { getProjects } from '../api/projects'
import OperationForm from '../components/OperationForm'
import AiQuickEntry from '../components/AiQuickEntry'
import OperationTemplates from '../components/OperationTemplates'
import { createTemplate } from '../api/operationTemplates'
import Layout from '../components/Layout'
import PeriodPicker from '../components/PeriodPicker'
import usePersistedPeriod from '../hooks/usePersistedPeriod'
import usePersistedState from '../hooks/usePersistedState'
import BulkEditOperations from '../components/BulkEditOperations'

const INFO_TYPES = [
  { id: 'partner', name: 'Контрагенты' },
  { id: 'product', name: 'Товары/Услуги' },
  { id: 'cash', name: 'Кассы/Счета' },
  { id: 'employee', name: 'Сотрудники' },
  { id: 'revenue', name: 'Статьи доходов' },
  { id: 'expenses', name: 'Статьи расходов' },
  { id: 'department', name: 'Отделы' },
  { id: 'flow', name: 'Статьи ДДС' },
]

const SearchableSelect = ({ label, value, onChange, options, placeholder }) => {
  const [search, setSearch] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  // Фильтруем опции по вводу пользователя
  const filtered = options.filter(opt => 
    opt.name.toLowerCase().includes(search.toLowerCase()) || 
    (opt.code && opt.code.toLowerCase().includes(search.toLowerCase()))
  )

  const selectedOption = options.find(o => o.id === value)

  return (
    <div className="relative flex flex-col gap-1">
      <span className="text-xs text-gray-500 font-medium">{label}:</span>
      <div className="relative">
        <input
          type="text"
          className="w-full px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={selectedOption ? selectedOption.name : placeholder}
          value={search}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => setSearch(e.target.value)}
        />
        {isOpen && (
          <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
            {filtered.length > 0 ? filtered.map(opt => (
              <div
                key={opt.id}
                className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer flex justify-between"
                onClick={() => {
                  onChange(opt.id)
                  setSearch('')
                  setIsOpen(false)
                }}
              >
                <span>{opt.name}</span>
                {opt.code && <span className="text-gray-400 text-xs font-mono">{opt.code}</span>}
              </div>
            )) : <div className="px-3 py-2 text-sm text-gray-400">Ничего не найдено</div>}
          </div>
        )}
      </div>
      {isOpen && <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)}></div>}
    </div>
  )
}



// Единая сетка колонок для шапки и карточек операций (выравнивание между карточками).
// Содержание — предпоследняя колонка: под ним ещё и примечание с реквизитами
// контрагента, поэтому она расширена (130px/1fr → 207px/1.59fr) и теперь заметно
// шире колонок дебета и кредита.
const OP_GRID = 'grid grid-cols-[2rem_2.5rem_10rem_minmax(170px,1.3fr)_minmax(170px,1.3fr)_7.5rem_minmax(207px,1.59fr)_4rem] gap-x-3'

export default function OperationsPage() {
  const navigate = useNavigate()
  const [operations, setOperations] = useState([])
  const [balanceItems, setBalanceItems] = useState([])
  const [projects, setProjects] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editOperation, setEditOperation] = useState(null)
  const [draftOperation, setDraftOperation] = useState(null)   // черновик от ИИ
  const [aiResetKey, setAiResetKey] = useState(0)              // сброс панели ИИ после сохранения
  const [tplKey, setTplKey] = useState(0)                      // перезагрузка списка шаблонов
  const [loading, setLoading] = useState(true)
  // Период запоминается между заходами и хранится отдельно от прочих фильтров
  const [period, setPeriod] = usePersistedPeriod('operations')
  const [filter, setFilter] = useState({ in_bi_id: '', out_bi_id: '', project_id: '', is_posted: '' })
  const [selected, setSelected] = useState(new Set())
  const [showBulkEdit, setShowBulkEdit] = useState(false)
  // Примечание — отдельной строкой под карточкой. Кому мешает, тот выключит
  const [showNotes, setShowNotes] = usePersistedState('ops:show-notes', true)
  const tenant = JSON.parse(localStorage.getItem('tenant') || '{}')

    // --- НОВЫЕ СОСТОЯНИЯ ---
  const [infoType, setInfoType] = useState('')       // Тип (partner, product и т.д.)
  const [infoOptions, setInfoOptions] = useState([]) // Список элементов из БД
  const [selectedInfoId, setSelectedInfoId] = useState('') // Конкретный ID элемента

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getBalanceItems().then(res => setBalanceItems(res.data.data))
    getProjects().then(res => setProjects(res.data.data || []))
  }, [])
  // Загружаем элементы справочника при смене типа (например, выбрали "Контрагенты")
  useEffect(() => {
    if (infoType) {
      api.get('/info', { params: { type: infoType } })
        .then(res => setInfoOptions(res.data.data))
        .catch(err => console.error("Ошибка загрузки справочника:", err))
    } else {
      setInfoOptions([])
    }
    setSelectedInfoId('') // Сбрасываем фильтр по конкретному элементу
  }, [infoType])

 
  useEffect(() => {
    loadOperations()
  }, [filter, period, selectedInfoId])

  const loadOperations = () => {
    setLoading(true)
    setSelected(new Set())
    const params = { per_page: 200 }

    // Сохраняем старые фильтры
    if (period.from)      params.date_from  = period.from
    if (period.to)        params.date_to    = period.to
    if (filter.in_bi_id)  params.in_bi_id   = filter.in_bi_id
    if (filter.out_bi_id) params.out_bi_id  = filter.out_bi_id
    if (filter.project_id) params.project_id = filter.project_id
    // Именно !== '': «0» — это осмысленный фильтр «только непроведённые»
    if (filter.is_posted !== '') params.is_posted = filter.is_posted

    // --- ДОБАВЛЯЕМ НОВЫЙ ФИЛЬТР ---
    if (selectedInfoId)   params.info_id    = selectedInfoId

    getOperations(params)
      .then(res => setOperations(res.data.data))
      .finally(() => setLoading(false))
  }

  // Проведение — не правка реквизитов, а включение операции в обороты,
  // поэтому отдельным запросом и без формы
  const togglePosting = async (op) => {
    try {
      await setOperationPosting(op.id, !op.is_posted)
      loadOperations()
    } catch (err) {
      alert(err.response?.data?.message || 'Не удалось изменить проведение')
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Удалить операцию?')) return
    try {
      await deleteOperation(id)
      loadOperations()
    } catch (err) {
      alert(err.response?.data?.message || 'Не удалось удалить операцию')
    }
  }

  const handleEdit = (op) => { setDraftOperation(null); setEditOperation(op); setShowForm(true) }
  const handleUseDraft = (payload) => { setEditOperation(null); setDraftOperation(payload); setShowForm(true) }
  const handleFormClose = () => { setShowForm(false); setEditOperation(null); setDraftOperation(null) }

  // Сохранить операцию как шаблон для повторения в следующем периоде
  const saveTemplate = async (payload, defaultName) => {
    const name = prompt('Название шаблона (короткая фраза для кнопки):', defaultName || '')
    if (!name || !name.trim()) return
    try {
      await createTemplate(name.trim(), payload)
      setTplKey(k => k + 1)
    } catch (err) {
      alert(err.response?.data?.message || 'Не удалось сохранить шаблон')
    }
  }

  const templateFromOp = (op) => saveTemplate({
    project_id: op.project_id, amount: op.amount, quantity: op.quantity,
    in_bi_id: op.in_bi_id, out_bi_id: op.out_bi_id,
    in_info_1_id: op.in_info_1_id, in_info_2_id: op.in_info_2_id, in_info_3_id: op.in_info_3_id,
    out_info_1_id: op.out_info_1_id, out_info_2_id: op.out_info_2_id, out_info_3_id: op.out_info_3_id,
    content: op.content, note: op.note,
  }, op.content || '')

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(selected.size === operations.length ? new Set() : new Set(operations.map(op => op.id)))
  }

  const allChecked  = operations.length > 0 && selected.size === operations.length
  const someChecked = selected.size > 0 && selected.size < operations.length

  const totalAll      = operations.reduce((sum, op) => sum + parseFloat(op.amount), 0)
  const totalSelected = operations.filter(op => selected.has(op.id)).reduce((sum, op) => sum + parseFloat(op.amount), 0)

  const accountTotals = useMemo(() => {
    const map = {}
    operations.forEach(op => {
      if (!map[op.in_bi_id])  map[op.in_bi_id]  = { code: op.in_bi_code,  name: op.in_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, ''),  debit: 0, credit: 0 }
      if (!map[op.out_bi_id]) map[op.out_bi_id] = { code: op.out_bi_code, name: op.out_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, ''), debit: 0, credit: 0 }
      map[op.in_bi_id].debit   += parseFloat(op.amount)
      map[op.out_bi_id].credit += parseFloat(op.amount)
    })
    return Object.values(map).sort((a, b) => a.code?.localeCompare(b.code))
  }, [operations])

  const formatAmount = (amount) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(amount)

  const formatDate = (date) =>
    new Date(date).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })

  const handleCopySelected = async () => {
    if (selected.size === 0) return
    if (!confirm(`Скопировать выбранные операции (${selected.size} шт.)?`)) return
  
    setLoading(true)
    try {
      // Фильтруем массив операций, оставляя только выделенные
      const opsToCopy = operations.filter(op => selected.has(op.id))
  
      // Выполняем запросы последовательно (или через Promise.all)
      for (const op of opsToCopy) {
        const payload = {
          date: op.date, // Оставляем оригинальную дату
          project_id: op.project_id,
          amount: op.amount,
          quantity: op.quantity,
          in_bi_id: op.in_bi_id,
          in_info_1_id: op.in_info_1_id,
          in_info_2_id: op.in_info_2_id,
          in_info_3_id: op.in_info_3_id,
          out_bi_id: op.out_bi_id,
          out_info_1_id: op.out_info_1_id,
          out_info_2_id: op.out_info_2_id,
          out_info_3_id: op.out_info_3_id,
          content: op.content ?? '',
          note: op.note ? `${op.note} (Копия)` : 'Копия'
        }
        await createOperation(payload)
      }
      
      // Сбрасываем выделение и обновляем список
      setSelected(new Set())
      loadOperations()
    } catch (err) {
      alert(err.response?.data?.message || 'Произошла ошибка при копировании')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }
  

  return (
    <Layout>
      {/* Карточки */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Операций за период</p>
          <p className="text-3xl font-bold text-gray-800">{operations.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Сумма за период</p>
          <p className="text-2xl font-bold text-blue-600">{formatAmount(totalAll)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">
            Выбрано {selected.size > 0 ? `(${selected.size})` : ''}
          </p>
          <p className={`text-2xl font-bold ${selected.size > 0 ? 'text-orange-500' : 'text-gray-300'}`}>
            {formatAmount(totalSelected)}
          </p>
        </div>
      </div>

      {/* Шаблоны регулярных операций */}
      <OperationTemplates onUse={handleUseDraft} refreshKey={tplKey} />

      {/* Быстрый ввод через ИИ (скрыт, если ключ не настроен) */}
      <AiQuickEntry onUseDraft={handleUseDraft} onSaveTemplate={saveTemplate}
        onChanged={loadOperations} resetKey={aiResetKey} />

      {/* Таблица операций */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm mb-4">
        
        {/* Замени блок заголовка таблицы */}
<div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
  <div className="flex items-center gap-4">
    <h2 className="font-semibold text-gray-800">Операции</h2>
    {selected.size > 0 && (
      <>
        <button
          onClick={() => setShowBulkEdit(true)}
          className="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors border border-blue-100"
        >
          <span>✎ Изменить</span>
          <span className="bg-blue-200 px-1.5 py-0.5 rounded text-[10px]">{selected.size}</span>
        </button>
        <button
          onClick={handleCopySelected}
          className="flex items-center gap-1.5 bg-orange-50 text-orange-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-orange-100 transition-colors border border-orange-100"
        >
          <span>📄 Копировать</span>
          <span className="bg-orange-200 px-1.5 py-0.5 rounded text-[10px]">{selected.size}</span>
        </button>
      </>
    )}
  </div>
  <div className="flex items-center gap-2">
    <button
      onClick={() => setShowNotes(v => !v)}
      title={showNotes ? 'Скрыть примечания' : 'Показать примечания'}
      className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
        showNotes
          ? 'bg-blue-50 border-blue-200 text-blue-700'
          : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
      }`}
    >
      💬 Примечания
    </button>
    <button
      onClick={() => { setEditOperation(null); setShowForm(true) }}
      className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors"
    >
      + Добавить
    </button>
  </div>
</div>

        {/* Фильтры */}
        <div className="px-6 py-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <PeriodPicker value={period} onChange={setPeriod} allowAll />
            <span className="text-gray-300">|</span>
            <div className="flex items-center gap-4 flex-wrap">
  {projects.length > 1 && (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 font-medium">Проект:</span>
      <select
        value={filter.project_id}
        onChange={e => setFilter(f => ({ ...f, project_id: e.target.value }))}
        className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48"
      >
        <option value="">Все проекты</option>
        {projects.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </div>
  )}
  <div className="flex items-center gap-2">
    <span className="text-xs text-gray-500 font-medium">Аналитика:</span>
    <select 
      value={infoType} 
      onChange={e => setInfoType(e.target.value)}
      className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <option value="">Тип не выбран</option>
      <option value="partner">Контрагенты</option>
      <option value="product">Товары</option>
      <option value="cash">Кассы</option>
      <option value="employee">Сотрудники</option>
    </select>
  </div>

  {infoType && (
    <div className="flex items-center gap-2">
      <select 
        value={selectedInfoId} 
        onChange={e => setSelectedInfoId(e.target.value)}
        className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48"
      >
        <option value="">Все элементы {infoType}</option>
        {infoOptions.map(opt => (
          <option key={opt.id} value={opt.id}>{opt.name}</option>
        ))}
      </select>
    </div>
  )}
</div>
            {loading && <span className="text-xs text-gray-400">Загрузка...</span>}
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Дебет:</span>
              <select value={filter.in_bi_id}
                onChange={e => setFilter(f => ({ ...f, in_bi_id: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48">
                <option value="">Все счета</option>
                {balanceItems.map(item => (
                  <option key={item.id} value={item.id}>{item.code} — {item.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Кредит:</span>
              <select value={filter.out_bi_id}
                onChange={e => setFilter(f => ({ ...f, out_bi_id: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48">
                <option value="">Все счета</option>
                {balanceItems.map(item => (
                  <option key={item.id} value={item.id}>{item.code} — {item.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Проведение:</span>
              <select value={filter.is_posted}
                onChange={e => setFilter(f => ({ ...f, is_posted: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Все</option>
                <option value="1">Проведённые</option>
                <option value="0">Непроведённые</option>
              </select>
            </div>
            {(filter.in_bi_id || filter.out_bi_id) && (
              <button onClick={() => setFilter(f => ({ ...f, in_bi_id: '', out_bi_id: '' }))}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                × сбросить
              </button>
            )}
          </div>
        </div>

        {!loading && operations.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">Нет операций за выбранный период</p>
            <button onClick={() => setShowForm(true)} className="text-blue-600 hover:underline text-sm">
              Добавить операцию
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto px-4 pt-3 pb-4 bg-gray-50/60 rounded-b-xl">
            <div className="min-w-[1050px]">
              {/* Шапка колонок */}
              <div className={`${OP_GRID} items-center px-4 pb-2 text-xs text-gray-500 uppercase tracking-wide`}>
                <div>
                  <input type="checkbox" checked={allChecked}
                    ref={el => { if (el) el.indeterminate = someChecked }}
                    onChange={toggleAll} className="rounded" />
                </div>
                <div>#</div>
                <div>Дата</div>
                <div>Дебет</div>
                <div>Кредит</div>
                <div className="text-right">Сумма</div>
                <div>Содержание</div>
                <div></div>
              </div>

              {/* Карточки операций */}
              <div className="space-y-2">
                {operations.map(op => (
                  <div key={op.id}
                    onClick={() => toggleSelect(op.id)}
                    onDoubleClick={() => (op.table_name === 'documents' && op.table_id)
                      ? navigate(`/documents?open=${op.table_id}`)
                      : handleEdit(op)}
                    title="Двойной клик — редактировать"
                    // Непроведённая — пунктиром и приглушённая: она в списке
                    // есть, а в оборотах её нет, и это должно быть видно сразу
                    className={`px-4 py-3 rounded-xl border cursor-pointer select-none transition-all group ${
                      selected.has(op.id)
                        ? 'border-orange-200 bg-orange-50 ring-1 ring-orange-200'
                        : op.is_posted === false
                          ? 'border-dashed border-gray-300 bg-gray-50 hover:border-blue-300'
                          : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'
                    }`}
                  >
                    <div className={`${OP_GRID} items-start`}>
                    <div onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(op.id)}
                        onChange={() => toggleSelect(op.id)} className="rounded" />
                    </div>
                    <div className="text-xs text-gray-400 font-mono pt-0.5">{op.id}</div>
                    <div className="text-sm text-gray-600 whitespace-nowrap pt-0.5">{formatDate(op.date)}</div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.in_bi_code}</span>
                        <span className="text-xs text-gray-600">{op.in_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                      </div>
                      {op.in_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.in_info_1_name}</span> <span className="text-gray-300">#{op.in_info_1_id}</span></div>}
                      {op.in_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.in_info_2_name}</span> <span className="text-gray-300">#{op.in_info_2_id}</span></div>}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.out_bi_code}</span>
                        <span className="text-xs text-gray-600">{op.out_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                      </div>
                      {op.out_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.out_info_1_name}</span> <span className="text-gray-300">#{op.out_info_1_id}</span></div>}
                      {op.out_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.out_info_2_name}</span> <span className="text-gray-300">#{op.out_info_2_id}</span></div>}
                    </div>
                    <div className="text-right whitespace-nowrap pt-0.5">
                      <div className={`font-semibold ${op.is_posted === false ? 'text-gray-400' : 'text-gray-800'}`}>
                        {formatAmount(op.amount)}
                      </div>
                      {op.is_posted === false && (
                        <div className="text-[10px] text-gray-500 bg-gray-200 rounded px-1 mt-0.5 inline-block">
                          не проведена
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      {op.content
                        ? <div className="text-xs text-gray-700 line-clamp-2 break-words" title={op.content}>{op.content}</div>
                        : (!showNotes || !op.note) && <span className="text-gray-300">—</span>}

                      {/* Примечание — сразу под содержанием. Не обрезаем в одну
                          строку: в нём реквизиты контрагента из выписки */}
                      {showNotes && op.note && (
                        <div
                          // ИНН и р/с нужно уметь скопировать; выделил текст —
                          // карточка не переключается
                          onClick={e => { if (!window.getSelection()?.isCollapsed) e.stopPropagation() }}
                          title={op.note}
                          className={`flex items-start gap-1 text-[11px] text-gray-400 leading-snug
                                      select-text cursor-auto ${op.content ? 'mt-1' : ''}`}>
                          <span className="text-gray-300 flex-shrink-0 select-none">💬</span>
                          <span className="break-words line-clamp-3">{op.note}</span>
                        </div>
                      )}
                    </div>
                    <div className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {op.table_name === 'documents' && op.table_id ? (
                          <button onClick={() => navigate(`/documents?open=${op.table_id}`)} title="Открыть документ-источник"
                            className="text-blue-400 hover:text-blue-600 p-1 rounded hover:bg-blue-50">📄</button>
                        ) : (
                          <>
                            <button onClick={() => togglePosting(op)}
                              title={op.is_posted === false ? 'Провести — попадёт в обороты' : 'Снять проведение — уйдёт из оборотов'}
                              className={op.is_posted === false
                                ? 'text-gray-400 hover:text-green-600 p-1 rounded hover:bg-green-50'
                                : 'text-gray-300 hover:text-gray-600 p-1 rounded hover:bg-gray-100'}>
                              {op.is_posted === false ? '✓' : '⊘'}
                            </button>
                            <button onClick={() => templateFromOp(op)} className="text-gray-300 hover:text-amber-500 p-1 rounded hover:bg-amber-50" title="Сохранить как шаблон">
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1L12 2z"/></svg>
                            </button>
                            <button onClick={() => handleEdit(op)} className="text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50" title="Редактировать"><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                            <button onClick={() => handleDelete(op.id)} className="text-gray-400 hover:text-red-500 text-base p-1 rounded hover:bg-red-50">×</button>
                          </>
                        )}
                      </div>
                    </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Обороты по счетам — под таблицей */}
      {accountTotals.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
          <div className="px-6 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-800">Обороты по счетам</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-50">
                  <th className="text-left px-6 py-2">Счёт</th>
                  <th className="text-right px-6 py-2 text-green-600">Дебет</th>
                  <th className="text-right px-6 py-2 text-red-500">Кредит</th>
                  <th className="text-right px-6 py-2 text-gray-500">Сальдо</th>
                </tr>
              </thead>
              <tbody>
                {accountTotals.map(acc => (
                  <tr key={acc.code} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-6 py-2">
                      <span className="text-xs font-mono font-medium text-gray-700 mr-2">{acc.code}</span>
                      <span className="text-xs text-gray-400">{acc.name}</span>
                    </td>
                    <td className="px-6 py-2 text-right text-xs font-medium text-green-600 whitespace-nowrap">
                      {acc.debit > 0 ? formatAmount(acc.debit) : '—'}
                    </td>
                    <td className="px-6 py-2 text-right text-xs font-medium text-red-500 whitespace-nowrap">
                      {acc.credit > 0 ? formatAmount(acc.credit) : '—'}
                    </td>
                    <td className="px-6 py-2 text-right text-xs font-medium text-gray-700 whitespace-nowrap">
                      {formatAmount(acc.debit - acc.credit)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td className="px-6 py-2 text-xs font-semibold text-gray-600">Итого</td>
                  <td className="px-6 py-2 text-right text-xs font-bold text-green-600 whitespace-nowrap">
                    {formatAmount(accountTotals.reduce((s, a) => s + a.debit, 0))}
                  </td>
                  <td className="px-6 py-2 text-right text-xs font-bold text-red-500 whitespace-nowrap">
                    {formatAmount(accountTotals.reduce((s, a) => s + a.credit, 0))}
                  </td>
                  <td className="px-6 py-2 text-right text-xs font-bold text-gray-700 whitespace-nowrap">
                    {formatAmount(accountTotals.reduce((s, a) => s + (a.debit - a.credit), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <OperationForm
          operation={editOperation}
          initial={draftOperation}
          onSuccess={() => { if (draftOperation) setAiResetKey(k => k + 1); handleFormClose(); loadOperations() }}
          onCancel={handleFormClose}
        />
      )}

      {showBulkEdit && (
        <BulkEditOperations
          ids={[...selected]}
          balanceItems={balanceItems}
          projects={projects}
          onClose={() => setShowBulkEdit(false)}
          onApplied={loadOperations}
        />
      )}
    </Layout>
  )
}
