import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { getOperations, deleteOperation, getBalanceItems } from '../api/operations'
import OperationForm from '../components/OperationForm'
import Layout from '../components/Layout'

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
  const tenant = JSON.parse(localStorage.getItem('tenant') || '{}')

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getBalanceItems().then(res => setBalanceItems(res.data.data))
  }, [])

  useEffect(() => {
    loadOperations()
  }, [filter])

  const loadOperations = () => {
    setLoading(true)
    const params = { per_page: 200 }
    if (filter.from)      params.date_from  = filter.from
    if (filter.to)        params.date_to    = filter.to
    if (filter.in_bi_id)  params.in_bi_id   = filter.in_bi_id
    if (filter.out_bi_id) params.out_bi_id  = filter.out_bi_id
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

  const formatAmount = (amount) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(amount)

  const formatDate = (date) =>
    new Date(date).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })

  const totalDebit  = operations.reduce((sum, op) => sum + parseFloat(op.amount), 0)
  const totalCredit = operations.reduce((sum, op) => sum + parseFloat(op.amount), 0)

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
    const now  = new Date()
    const mr   = getMonthRange()
    const td   = localDate(now)
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

  return (
    <Layout>
      {/* Карточки */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Операций за период</p>
          <p className="text-3xl font-bold text-gray-800">{operations.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Дебет за период</p>
          <p className="text-2xl font-bold text-green-600">{formatAmount(totalDebit)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Кредит за период</p>
          <p className="text-2xl font-bold text-red-500">{formatAmount(totalCredit)}</p>
        </div>
      </div>

      {/* Таблица */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Операции</h2>
          <button
            onClick={() => { setEditOperation(null); setShowForm(true) }}
            className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors"
          >
            + Добавить
          </button>
        </div>

        {/* Фильтры */}
        <div className="px-6 py-3 border-b border-gray-100 space-y-2">
          {/* Период */}
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
            {loading && <span className="text-xs text-gray-400">Загрузка...</span>}
          </div>

          {/* Фильтр по счетам */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium w-12">Дебет:</span>
              <select value={filter.in_bi_id}
                onChange={e => setFilter(f => ({ ...f, in_bi_id: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-56">
                <option value="">Все счета</option>
                {balanceItems.map(item => (
                  <option key={item.id} value={item.id}>{item.code} — {item.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium w-12">Кредит:</span>
              <select value={filter.out_bi_id}
                onChange={e => setFilter(f => ({ ...f, out_bi_id: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-56">
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
                  <th className="text-left px-4 py-3 w-12">#</th>
                  <th className="text-left px-4 py-3">Дата</th>
                  <th className="text-left px-4 py-3">Дебет</th>
                  <th className="text-left px-4 py-3">Кредит</th>
                  <th className="text-right px-4 py-3">Сумма</th>
                  <th className="text-left px-4 py-3">Комментарий</th>
                  <th className="px-4 py-3 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {operations.map(op => (
                  <tr key={op.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors group">
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{op.id}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{formatDate(op.date)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.in_bi_code}</span>
                        <span className="text-xs text-gray-600">{op.in_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                      </div>
                      {op.in_info_1_name && (
                        <div className="text-xs text-gray-400 mt-0.5 pl-0.5">
                          ↳ <span className="text-gray-500">{op.in_info_1_name}</span>
                          <span className="text-gray-300 ml-1">#{op.in_info_1_id}</span>
                        </div>
                      )}
                      {op.in_info_2_name && (
                        <div className="text-xs text-gray-400 mt-0.5 pl-0.5">
                          ↳ <span className="text-gray-500">{op.in_info_2_name}</span>
                          <span className="text-gray-300 ml-1">#{op.in_info_2_id}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.out_bi_code}</span>
                        <span className="text-xs text-gray-600">{op.out_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                      </div>
                      {op.out_info_1_name && (
                        <div className="text-xs text-gray-400 mt-0.5 pl-0.5">
                          ↳ <span className="text-gray-500">{op.out_info_1_name}</span>
                          <span className="text-gray-300 ml-1">#{op.out_info_1_id}</span>
                        </div>
                      )}
                      {op.out_info_2_name && (
                        <div className="text-xs text-gray-400 mt-0.5 pl-0.5">
                          ↳ <span className="text-gray-500">{op.out_info_2_name}</span>
                          <span className="text-gray-300 ml-1">#{op.out_info_2_id}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-800 whitespace-nowrap">{formatAmount(op.amount)}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">{op.note || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => handleEdit(op)}
                          className="text-gray-400 hover:text-blue-600 text-sm p-1.5 rounded hover:bg-blue-50 transition-colors">✎</button>
                        <button onClick={() => handleDelete(op.id)}
                          className="text-gray-400 hover:text-red-500 text-base p-1.5 rounded hover:bg-red-50 transition-colors">×</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
