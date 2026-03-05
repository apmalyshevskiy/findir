import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { getBalanceSheet, getBalanceItems, getOperations } from '../api/operations'
import OperationForm from '../components/OperationForm'

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

const INFO_TYPES = [
  { value: '',           label: 'Без аналитики' },
  { value: 'partner',    label: 'Контрагенты' },
  { value: 'product',    label: 'Товары/Услуги' },
  { value: 'cash',       label: 'Кассы/Счета' },
  { value: 'employee',   label: 'Сотрудники' },
  { value: 'revenue',    label: 'Статьи доходов' },
  { value: 'expenses',   label: 'Статьи расходов' },
  { value: 'department', label: 'Отделы' },
  { value: 'flow',       label: 'Статьи движения' },
]

const fmt = (amount) => amount === 0 ? '—' :
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(amount)

const formatDate = (date) =>
  new Date(date).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })

export default function BalanceSheetPage() {
  const [data, setData]               = useState([])
  const [balanceItems, setBalanceItems] = useState([])
  const [filter, setFilter]           = useState(getMonthRange())
  const [infoType, setInfoType]       = useState('')
  const [biFilter, setBiFilter]       = useState('')
  const [loading, setLoading]         = useState(false)
  const [expanded, setExpanded]       = useState(new Set())
  const [drillModal, setDrillModal]   = useState(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [editOp, setEditOp]           = useState(null)

  useEffect(() => {
    getBalanceItems().then(res => setBalanceItems(res.data.data))
  }, [])

  useEffect(() => { load() }, [filter, infoType, biFilter])

  const load = () => {
    setLoading(true)
    setExpanded(new Set())
    const params = { date_from: filter.from, date_to: filter.to }
    if (infoType) params.info_type = infoType
    if (biFilter) params.bi_id    = biFilter
    getBalanceSheet(params)
      .then(res => setData(res.data.data))
      .finally(() => setLoading(false))
  }

  const toggleExpand = (biId) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(biId) ? next.delete(biId) : next.add(biId)
      return next
    })
  }

  const expandAll   = () => setExpanded(new Set(data.filter(r => r.has_analytics && r.children?.length > 0).map(r => r.bi_id)))
  const collapseAll = () => setExpanded(new Set())

  // direction: 'debit' = счёт был в дебете операции (in_bi_id)
  //            'credit' = счёт был в кредите операции (out_bi_id)
  //            'both' = сальдо (все операции по счёту)
  const openDrill = async (title, biId, direction, infoId = null) => {
    setDrillLoading(true)
    setDrillModal({ title, ops: [], biId, direction, infoId })
    const params = { per_page: 200, date_from: filter.from, date_to: filter.to }

    let ops = []
    if (direction === 'debit') {
      const res = await getOperations({ ...params, in_bi_id: biId })
      ops = res.data.data || []
    } else if (direction === 'credit') {
      const res = await getOperations({ ...params, out_bi_id: biId })
      ops = res.data.data || []
    } else {
      // both — для сальдо грузим все операции по счёту
      const [resIn, resOut] = await Promise.all([
        getOperations({ ...params, in_bi_id: biId }),
        getOperations({ ...params, out_bi_id: biId }),
      ])
      const all = [...(resIn.data.data || []), ...(resOut.data.data || [])]
      ops = all.filter((op, idx, self) => self.findIndex(o => o.id === op.id) === idx)
    }

    // Фильтр по info если есть
    if (infoId) {
      ops = ops.filter(op =>
        op.in_info_1_id == infoId || op.in_info_2_id == infoId ||
        op.out_info_1_id == infoId || op.out_info_2_id == infoId
      )
    }

    ops.sort((a, b) => new Date(b.date) - new Date(a.date))
    setDrillModal({ title, ops, biId, direction, infoId })
    setDrillLoading(false)
  }

  const handleEditSaved = () => {
    setEditOp(null)
    // Обновляем список в модалке
    if (drillModal) {
      openDrill(drillModal.title, drillModal.biId, drillModal.direction, drillModal.infoId)
    }
    load()
  }

  const setPeriod = (type) => {
    const now = new Date()
    if (type === 'month') setFilter(getMonthRange())
    else if (type === 'quarter') {
      const q = Math.floor(now.getMonth() / 3)
      setFilter({ from: localDate(new Date(now.getFullYear(), q * 3, 1)), to: localDate(new Date(now.getFullYear(), q * 3 + 3, 0)) })
    } else if (type === 'year') {
      setFilter({ from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` })
    }
  }

  const activePeriod = () => {
    const mr  = getMonthRange()
    const now = new Date()
    if (filter.from === mr.from && filter.to === mr.to) return 'month'
    if (filter.from === `${now.getFullYear()}-01-01`) return 'year'
    return ''
  }

  const totals = data.reduce((acc, row) => ({
    opening_debit:  acc.opening_debit  + row.opening_debit,
    opening_credit: acc.opening_credit + row.opening_credit,
    debit:          acc.debit          + row.debit,
    credit:         acc.credit         + row.credit,
    closing_debit:  acc.closing_debit  + row.closing_debit,
    closing_credit: acc.closing_credit + row.closing_credit,
  }), { opening_debit: 0, opening_credit: 0, debit: 0, credit: 0, closing_debit: 0, closing_credit: 0 })

  const NumCell = ({ val, onClick, extra = '' }) => (
    <td className={`px-4 py-2.5 text-right text-xs font-medium whitespace-nowrap ${extra}`}>
      {val === 0 ? (
        <span className="text-gray-300">—</span>
      ) : (
        <button onClick={onClick}
          className="hover:underline hover:opacity-75 transition-opacity cursor-pointer">
          {fmt(val)}
        </button>
      )}
    </td>
  )

  return (
    <Layout>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-semibold text-gray-800">Оборотно-сальдовая ведомость</h2>
      </div>

      {/* Фильтры */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex gap-1.5">
            {[{key:'month',label:'Месяц'},{key:'quarter',label:'Квартал'},{key:'year',label:'Год'}].map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                  activePeriod() === p.key ? 'bg-blue-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
            <span className="text-gray-400">—</span>
            <input type="date" value={filter.to}
              onChange={e => setFilter(f => ({ ...f, to: e.target.value }))}
              className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {loading && <span className="text-xs text-gray-400">Загрузка...</span>}
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">Счёт:</span>
            <select value={biFilter} onChange={e => setBiFilter(e.target.value)}
              className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-56">
              <option value="">Все счета</option>
              {balanceItems.map(item => (
                <option key={item.id} value={item.id}>{item.code} — {item.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">Аналитика:</span>
            <select value={infoType} onChange={e => setInfoType(e.target.value)}
              className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {INFO_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          {infoType && data.filter(r => r.has_analytics && r.children?.length > 0).length > 0 && (
            <>
              <button onClick={expandAll}   className="text-xs text-blue-600 hover:underline">Раскрыть все</button>
              <button onClick={collapseAll} className="text-xs text-gray-400 hover:underline">Свернуть все</button>
            </>
          )}
        </div>
      </div>

      {/* Таблица ОСВ */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-2 text-xs text-gray-500 uppercase tracking-wide" rowSpan={2}>Счёт</th>
              <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100" colSpan={2}>Сальдо начальное</th>
              <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100 border-l border-gray-200" colSpan={2}>Обороты за период</th>
              <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100 border-l border-gray-200" colSpan={2}>Сальдо конечное</th>
            </tr>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-right px-4 py-2 text-xs text-green-600 font-medium">Дебет</th>
              <th className="text-right px-4 py-2 text-xs text-red-500 font-medium">Кредит</th>
              <th className="text-right px-4 py-2 text-xs text-green-600 font-medium border-l border-gray-200">Дебет</th>
              <th className="text-right px-4 py-2 text-xs text-red-500 font-medium">Кредит</th>
              <th className="text-right px-4 py-2 text-xs text-green-600 font-medium border-l border-gray-200">Дебет</th>
              <th className="text-right px-4 py-2 text-xs text-red-500 font-medium">Кредит</th>
            </tr>
          </thead>
          <tbody>
            {data.length === 0 && !loading ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Нет данных за выбранный период</td></tr>
            ) : data.map(row => {
              const hasChildren = row.has_analytics && row.children?.length > 0
              const isExpanded  = expanded.has(row.bi_id)
              return [
                <tr key={row.bi_id}
                  className={`border-b border-gray-100 transition-colors ${hasChildren ? 'cursor-pointer hover:bg-blue-50' : 'hover:bg-gray-50'} ${isExpanded ? 'bg-blue-50' : ''}`}
                  onClick={() => hasChildren && toggleExpand(row.bi_id)}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-3 text-gray-400 text-xs">{hasChildren ? (isExpanded ? '▼' : '▶') : ''}</span>
                      <span className="font-mono text-xs font-semibold text-gray-700">{row.code}</span>
                      <span className="text-xs text-gray-500">{row.name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                    </div>
                  </td>
                  <NumCell val={row.opening_debit}  extra="text-green-700" onClick={e => { e.stopPropagation(); openDrill(`${row.code} — сальдо нач. Дт`, row.bi_id, 'both') }} />
                  <NumCell val={row.opening_credit} extra="text-red-600"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} — сальдо нач. Кт`, row.bi_id, 'both') }} />
                  <NumCell val={row.debit}          extra="text-green-700 border-l border-gray-100" onClick={e => { e.stopPropagation(); openDrill(`${row.code} — обороты Дт`, row.bi_id, 'debit') }} />
                  <NumCell val={row.credit}         extra="text-red-600"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} — обороты Кт`, row.bi_id, 'credit') }} />
                  <NumCell val={row.closing_debit}  extra="text-green-700 border-l border-gray-100" onClick={e => { e.stopPropagation(); openDrill(`${row.code} — сальдо кон. Дт`, row.bi_id, 'both') }} />
                  <NumCell val={row.closing_credit} extra="text-red-600"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} — сальдо кон. Кт`, row.bi_id, 'both') }} />
                </tr>,
                ...(isExpanded ? row.children.map(child => (
                  <tr key={`${row.bi_id}-${child.info_id}`} className="border-b border-gray-50 bg-blue-50/30 hover:bg-blue-50/60">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2 pl-8">
                        <span className="text-gray-300 text-xs">└</span>
                        <span className="text-xs text-gray-600 font-medium">{child.info_name}</span>
                      </div>
                    </td>
                    <NumCell val={child.opening_debit}  extra="text-green-600" onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо нач. Дт`, row.bi_id, 'both', child.info_id) }} />
                    <NumCell val={child.opening_credit} extra="text-red-400"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо нач. Кт`, row.bi_id, 'both', child.info_id) }} />
                    <NumCell val={child.debit}          extra="text-green-600 border-l border-gray-100" onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — обороты Дт`, row.bi_id, 'debit', child.info_id) }} />
                    <NumCell val={child.credit}         extra="text-red-400"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — обороты Кт`, row.bi_id, 'credit', child.info_id) }} />
                    <NumCell val={child.closing_debit}  extra="text-green-600 border-l border-gray-100" onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо кон. Дт`, row.bi_id, 'both', child.info_id) }} />
                    <NumCell val={child.closing_credit} extra="text-red-400"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо кон. Кт`, row.bi_id, 'both', child.info_id) }} />
                  </tr>
                )) : [])
              ]
            })}
          </tbody>
          {data.length > 0 && (
            <tfoot>
              <tr className="bg-gray-50 border-t-2 border-gray-200">
                <td className="px-4 py-2.5 text-xs font-bold text-gray-700 pl-9">Итого</td>
                <td className="px-4 py-2.5 text-right text-xs font-bold text-green-700">{fmt(totals.opening_debit)}</td>
                <td className="px-4 py-2.5 text-right text-xs font-bold text-red-600">{fmt(totals.opening_credit)}</td>
                <td className="px-4 py-2.5 text-right text-xs font-bold text-green-700 border-l border-gray-100">{fmt(totals.debit)}</td>
                <td className="px-4 py-2.5 text-right text-xs font-bold text-red-600">{fmt(totals.credit)}</td>
                <td className="px-4 py-2.5 text-right text-xs font-bold text-green-700 border-l border-gray-100">{fmt(totals.closing_debit)}</td>
                <td className="px-4 py-2.5 text-right text-xs font-bold text-red-600">{fmt(totals.closing_credit)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Модалка дрилл-даун */}
      {drillModal && !editOp && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col">
            <div className="p-5 border-b border-gray-100 flex justify-between items-center">
              <h3 className="font-semibold text-gray-800">{drillModal.title}</h3>
              <button onClick={() => setDrillModal(null)} className="text-gray-400 hover:text-gray-600 text-xl px-2">×</button>
            </div>
            <div className="overflow-auto flex-1">
              {drillLoading ? (
                <div className="text-center py-12 text-gray-400">Загрузка...</div>
              ) : drillModal.ops.length === 0 ? (
                <div className="text-center py-12 text-gray-400">Операций не найдено</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white border-b border-gray-100">
                    <tr className="text-xs text-gray-500 uppercase tracking-wide">
                      <th className="text-left px-4 py-3 w-10">#</th>
                      <th className="text-left px-4 py-3">Дата</th>
                      <th className="text-left px-4 py-3">Дебет</th>
                      <th className="text-left px-4 py-3">Кредит</th>
                      <th className="text-right px-4 py-3">Сумма</th>
                      <th className="text-left px-4 py-3">Комментарий</th>
                      <th className="px-4 py-3 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillModal.ops.map(op => (
                      <tr key={op.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors group">
                        <td className="px-4 py-3 text-xs text-gray-400 font-mono">{op.id}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{formatDate(op.date)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.in_bi_code}</span>
                            <span className="text-xs text-gray-500">{op.in_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                          </div>
                          {op.in_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ {op.in_info_1_name}</div>}
                          {op.in_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ {op.in_info_2_name}</div>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.out_bi_code}</span>
                            <span className="text-xs text-gray-500">{op.out_bi_name?.replace(/^[А-ЯA-Z]\d+\s/, '')}</span>
                          </div>
                          {op.out_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ {op.out_info_1_name}</div>}
                          {op.out_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ {op.out_info_2_name}</div>}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-800 whitespace-nowrap">{fmt(op.amount)}</td>
                        <td className="px-4 py-3 text-sm text-gray-500">{op.note || '—'}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => setEditOp(op)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-600 text-sm p-1 rounded hover:bg-blue-50"
                          >
                            ✎
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-200 bg-gray-50">
                      <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-gray-600">
                        Итого ({drillModal.ops.length} операций)
                      </td>
                      <td className="px-4 py-2 text-right text-xs font-bold text-gray-800 whitespace-nowrap">
                        {fmt(drillModal.ops.reduce((s, op) => s + parseFloat(op.amount), 0))}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Форма редактирования операции */}
      {editOp && (
        <OperationForm
          operation={editOp}
          onSuccess={handleEditSaved}
          onCancel={() => setEditOp(null)}
        />
      )}
    </Layout>
  )
}
