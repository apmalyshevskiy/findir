import { useState, useEffect } from 'react'
import { getBalanceItems, createOperation, updateOperation } from '../api/operations'
import { getInfo } from '../api/info'

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
    note:          operation?.note ?? '',
  })

  // Загружаем balance_items и сразу подгружаем info для уже выбранных счетов
  useEffect(() => {
    getBalanceItems().then(res => {
      const items = res.data.data
      setBalanceItems(items)

      // Если редактирование — сразу загружаем нужные справочники
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

  // Подгружаем справочники при смене счёта
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

  const InfoSelect = ({ type, field, label }) => {
    if (!type) return null
    const items = infoCache[type] || []
    return (
      <div>
        <label className={lc}>{label}</label>
        <select value={form[field] || ''} onChange={e => setForm({...form, [field]: e.target.value})} className={ic}>
          <option value="">Не указано</option>
          {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
    )
  }

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
            <InfoSelect type={inBi.info_1_type} field="in_info_1_id"
              label={`${INFO_LABELS[inBi.info_1_type]} (${inBi.code})`} />
          )}
          {inBi?.info_2_type && (
            <InfoSelect type={inBi.info_2_type} field="in_info_2_id"
              label={`${INFO_LABELS[inBi.info_2_type]} (${inBi.code})`} />
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
            <InfoSelect type={outBi.info_1_type} field="out_info_1_id"
              label={`${INFO_LABELS[outBi.info_1_type]} (${outBi.code})`} />
          )}
          {outBi?.info_2_type && (
            <InfoSelect type={outBi.info_2_type} field="out_info_2_id"
              label={`${INFO_LABELS[outBi.info_2_type]} (${outBi.code})`} />
          )}

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
