import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { getOperations, deleteOperation, getBalanceItems, createOperation} from '../api/operations'
import OperationForm from '../components/OperationForm'
import Layout from '../components/Layout'

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



const localDate = (date) => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 10)
}

const getMonthRange = () => {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return { from: localDate(from), to: localDate(to) }
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const [operations, setOperations] = useState([])
  const [balanceItems, setBalanceItems] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editOperation, setEditOperation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState({ ...getMonthRange(), in_bi_id: '', out_bi_id: '' })
  const [selected, setSelected] = useState(new Set())
  const tenant = JSON.parse(localStorage.getItem('tenant') || '{}')

    // --- НОВЫЕ СОСТОЯНИЯ ---
  const [infoType, setInfoType] = useState('')       // Тип (partner, product и т.д.)
  const [infoOptions, setInfoOptions] = useState([]) // Список элементов из БД
  const [selectedInfoId, setSelectedInfoId] = useState('') // Конкретный ID элемента

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getBalanceItems().then(res => setBalanceItems(res.data.data))
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

 
  // Было: useEffect(() => { loadOperations() }, [filter])
  // Стало:
  useEffect(() => { 
    loadOperations() 
  }, [filter, selectedInfoId]) // <-- Добавили selectedInfoId сюда

  const loadOperations = () => {
    setLoading(true)
    setSelected(new Set())
    const params = { per_page: 200 }
    
    // Сохраняем старые фильтры
    if (filter.from)      params.date_from  = filter.from
    if (filter.to)        params.date_to    = filter.to
    if (filter.in_bi_id)  params.in_bi_id   = filter.in_bi_id
    if (filter.out_bi_id) params.out_bi_id  = filter.out_bi_id
    
    // --- ДОБАВЛЯЕМ НОВЫЙ ФИЛЬТР ---
    if (selectedInfoId)   params.info_id    = selectedInfoId 

    getOperations(params)
      .then(res => setOperations(res.data.data))
      .finally(() => setLoading(false))
  }

  const handleDelete = async (id) => {
    if (!confirm('Удалить операцию?')) return
    await deleteOperation(id)
    loadOperations()
  }

  const handleEdit = (op) => { setEditOperation(op); setShowForm(true) }
  const handleFormClose = () => { setShowForm(false); setEditOperation(null) }

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

  const setPeriod = (type) => {
    const now = new Date()
    if (type === 'today') {
      const d = localDate(now)
      setFilter(f => ({ ...f, from: d, to: d }))
    } else if (type === 'week') {
      const mon = new Date(now)
      mon.setDate(now.getDate() - ((now.getDay() + 6) % 7))
      setFilter(f => ({ ...f, from: localDate(mon), to: localDate(now) }))
    } else if (type === 'month') {
      setFilter(f => ({ ...f, ...getMonthRange() }))
    } else if (type === 'quarter') {
      const q = Math.floor(now.getMonth() / 3)
      const from = new Date(now.getFullYear(), q * 3, 1)
      const to   = new Date(now.getFullYear(), q * 3 + 3, 0)
      setFilter(f => ({ ...f, from: localDate(from), to: localDate(to) }))
    } else if (type === 'year') {
      setFilter(f => ({ ...f, from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` }))
    } else if (type === 'all') {
      setFilter(f => ({ ...f, from: '', to: '' }))
    }
  }

  const activePeriod = () => {
    const now = new Date()
    const mr  = getMonthRange()
    const td  = localDate(now)
    if (filter.from === td && filter.to === td) return 'today'
    if (filter.from === mr.from && filter.to === mr.to) return 'month'
    if (filter.from === '' && filter.to === '') return 'all'
    return ''
  }

  const periods = [
    { key: 'today',   label: 'Сегодня' },
    { key: 'week',    label: 'Неделя' },
    { key: 'month',   label: 'Месяц' },
    { key: 'quarter', label: 'Квартал' },
    { key: 'year',    label: 'Год' },
    { key: 'all',     label: 'Все' },
  ]

  const active = activePeriod()

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
      alert('Произошла ошибка при копировании')
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

      {/* Таблица операций */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm mb-4">
        
        {/* Замени блок заголовка таблицы */}
<div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
  <div className="flex items-center gap-4">
    <h2 className="font-semibold text-gray-800">Операции</h2>
    {selected.size > 0 && (
      <button
        onClick={handleCopySelected}
        className="flex items-center gap-1.5 bg-orange-50 text-orange-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-orange-100 transition-colors border border-orange-100"
      >
        <span>📄 Копировать</span>
        <span className="bg-orange-200 px-1.5 py-0.5 rounded text-[10px]">{selected.size}</span>
      </button>
    )}
  </div>
  <button
    onClick={() => { setEditOperation(null); setShowForm(true) }}
    className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors"
  >
    + Добавить
  </button>
</div>

        {/* Фильтры */}
        <div className="px-6 py-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-1.5">
              {periods.map(p => (
                <button key={p.key} onClick={() => setPeriod(p.key)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    active === p.key ? 'bg-blue-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                  {p.label}
                </button>
              ))}
            </div>
            <span className="text-gray-300">|</span>
            <div className="flex items-center gap-2">
              <input type="date" value={filter.from}
                onChange={e => setFilter(f => ({ ...f, from: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <span className="text-gray-400 text-sm">—</span>
              <input type="date" value={filter.to}
                onChange={e => setFilter(f => ({ ...f, to: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex items-center gap-4 flex-wrap pt-2 border-t border-gray-50">
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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100">
                  <th className="px-4 py-3 w-8">
                    <input type="checkbox" checked={allChecked}
                      ref={el => { if (el) el.indeterminate = someChecked }}
                      onChange={toggleAll} className="rounded" />
                  </th>
                  <th className="text-left px-3 py-3 w-10">#</th>
                  <th className="text-left px-3 py-3">Дата</th>
                  <th className="text-left px-3 py-3">Дебет</th>
                  <th className="text-left px-3 py-3">Кредит</th>
                  <th className="text-right px-3 py-3">Сумма</th>
                  <th className="text-left px-3 py-3">Содержание / Комментарий</th>
                  <th className="px-3 py-3 w-14"></th>
                </tr>
              </thead>
              <tbody>
                {operations.map(op => (
                  <tr key={op.id}
                    className={`border-b border-gray-50 transition-colors group cursor-pointer ${selected.has(op.id) ? 'bg-orange-50' : 'hover:bg-gray-50'}`}
                    onClick={() => toggleSelect(op.id)}
                  >
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(op.id)}
                        onChange={() => toggleSelect(op.id)} className="rounded" />
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-400 font-mono">{op.id}</td>
                    <td className="px-3 py-3 text-sm text-gray-600 whitespace-nowrap">{formatDate(op.date)}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.in_bi_code}</span>
                        <span className="text-xs text-gray-600">{op.in_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                      </div>
                      {op.in_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.in_info_1_name}</span> <span className="text-gray-300">#{op.in_info_1_id}</span></div>}
                      {op.in_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.in_info_2_name}</span> <span className="text-gray-300">#{op.in_info_2_id}</span></div>}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.out_bi_code}</span>
                        <span className="text-xs text-gray-600">{op.out_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                      </div>
                      {op.out_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.out_info_1_name}</span> <span className="text-gray-300">#{op.out_info_1_id}</span></div>}
                      {op.out_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500">{op.out_info_2_name}</span> <span className="text-gray-300">#{op.out_info_2_id}</span></div>}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold text-gray-800 whitespace-nowrap">{formatAmount(op.amount)}</td>
                    
                    <td className="px-3 py-3 max-w-xs">
                      {op.content && (
                      <div className="text-xs text-gray-700 truncate" title={op.content}>
                       {op.content}
                      </div>
                          )}
                        {op.note && (
                     <div className="text-xs text-gray-400 italic truncate" title={op.note}>
                         💬 {op.note}
                      </div>
                         )}
                      {!op.content && !op.note && (
                      <span className="text-gray-300">—</span>
                         )}
                      </td>
                    


                    
                    <td className="px-3 py-3 text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {op.table_name === 'documents' && op.table_id ? (
                          <button
                            onClick={() => navigate(`/documents?open=${op.table_id}`)}
                            title="Открыть документ-источник"
                            className="text-blue-400 hover:text-blue-600 text-xs px-2 py-1 rounded hover:bg-blue-50 flex items-center gap-1"
                          >
                            📄 <span className="text-xs">→ документ</span>
                          </button>
                        ) : (
                          <>
                            <button onClick={() => handleEdit(op)} className="text-gray-400 hover:text-blue-600 text-sm p-1 rounded hover:bg-blue-50">✎</button>
                            <button onClick={() => handleDelete(op.id)} className="text-gray-400 hover:text-red-500 text-base p-1 rounded hover:bg-red-50">×</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
          onSuccess={() => { handleFormClose(); loadOperations() }}
          onCancel={handleFormClose}
        />
      )}
    </Layout>
  )
}
