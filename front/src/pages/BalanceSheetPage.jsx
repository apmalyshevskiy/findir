import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import Layout from '../components/Layout'
import { getBalanceSheet, getBalanceItems, getOperations } from '../api/operations'
import { getInfo } from '../api/info'
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

// --- УМНЫЙ АЛГОРИТМ ПОСТРОЕНИЯ ИЕРАРХИИ С СУММИРОВАНИЕМ ---
const processHierarchy = (childrenBalances, dictionary, expandedSet = new Set(), biId = '', expandAll = false) => {
  if (!dictionary || dictionary.length === 0) {
    return childrenBalances.map(c => ({ ...c, depth: 0, treeChildren: [] }))
  }

  const balanceMap = {}
  childrenBalances.forEach(cb => { balanceMap[cb.info_id] = cb })

  const dictMap = {}
  dictionary.forEach(d => { dictMap[d.id] = d })

  const nodesToKeep = new Set()
  childrenBalances.forEach(cb => {
    let currentId = cb.info_id
    while (currentId && dictMap[currentId]) {
      nodesToKeep.add(currentId)
      currentId = dictMap[currentId].parent_id
    }
  })

  const enriched = Array.from(nodesToKeep).map(id => {
    const d = dictMap[id]
    const b = balanceMap[id] || { 
      opening_debit: 0, opening_credit: 0, 
      debit: 0, credit: 0, 
      closing_debit: 0, closing_credit: 0 
    }
    return {
      info_id: id,
      info_name: d.name,
      parent_id: d.parent_id,
      sort_order: d.sort_order,
      ...b
    }
  })

  const map = {}
  const roots = []
  enriched.forEach(item => { map[item.info_id] = { ...item, treeChildren: [] } })

  enriched.forEach(item => {
    if (item.parent_id && map[item.parent_id]) {
      map[item.parent_id].treeChildren.push(map[item.info_id])
    } else {
      roots.push(map[item.info_id])
    }
  })

  const calculateSums = (node) => {
    let sums = {
      opening_debit: parseFloat(node.opening_debit) || 0,
      opening_credit: parseFloat(node.opening_credit) || 0,
      debit: parseFloat(node.debit) || 0,
      credit: parseFloat(node.credit) || 0,
      closing_debit: parseFloat(node.closing_debit) || 0,
      closing_credit: parseFloat(node.closing_credit) || 0,
    }

    if (node.treeChildren && node.treeChildren.length > 0) {
      node.treeChildren.forEach(child => {
        const childSums = calculateSums(child)
        sums.opening_debit += childSums.opening_debit
        sums.opening_credit += childSums.opening_credit
        sums.debit += childSums.debit
        sums.credit += childSums.credit
        sums.closing_debit += childSums.closing_debit
        sums.closing_credit += childSums.closing_credit
      })
    }

    node.opening_debit = sums.opening_debit
    node.opening_credit = sums.opening_credit
    node.debit = sums.debit
    node.credit = sums.credit
    node.closing_debit = sums.closing_debit
    node.closing_credit = sums.closing_credit

    return sums
  }

  roots.forEach(root => calculateSums(root))

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      const oA = a.sort_order || 0
      const oB = b.sort_order || 0
      if (oA !== oB) return oA - oB
      return (a.info_name || '').localeCompare(b.info_name || '')
    })
    nodes.forEach(n => sortNodes(n.treeChildren))
  }
  sortNodes(roots)

  const flatten = (nodes, depth = 0) => {
    let res = []
    nodes.forEach(node => {
      res.push({ ...node, depth })
      const isExpanded = expandAll || expandedSet.has(`${biId}-${node.info_id}`)
      if (node.treeChildren?.length > 0 && isExpanded) {
        res = res.concat(flatten(node.treeChildren, depth + 1))
      }
    })
    return res
  }

  return flatten(roots)
}

export default function BalanceSheetPage() {
  const navigate = useNavigate()
  const [data, setData]               = useState([])
  const [balanceItems, setBalanceItems] = useState([])
  const [infoDictionary, setInfoDictionary] = useState([]) 
  const [filter, setFilter]           = useState(getMonthRange())
  const [infoType, setInfoType]       = useState('')
  const [biFilter, setBiFilter]       = useState('')
  const [loading, setLoading]         = useState(false)
  const [expanded, setExpanded]       = useState(new Set())
  const [expandedInfo, setExpandedInfo] = useState(new Set())
  const [drillModal, setDrillModal]   = useState(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [editOp, setEditOp]           = useState(null)

  useEffect(() => {
    getBalanceItems().then(res => setBalanceItems(res.data.data))
  }, [])

  useEffect(() => {
    if (infoType) {
      getInfo({ type: infoType }).then(res => setInfoDictionary(res.data.data))
    } else {
      setInfoDictionary([])
    }
  }, [infoType])

  useEffect(() => { load() }, [filter, infoType, biFilter])

  const load = () => {
    setLoading(true)
    setExpanded(new Set())
    setExpandedInfo(new Set())
    const params = { date_from: filter.from, date_to: filter.to }
    if (infoType) params.info_type = infoType
    if (biFilter) params.bi_id    = biFilter
    getBalanceSheet(params)
      .then(res => setData(res.data.data))
      .finally(() => setLoading(false))
  }

  const exportToExcel = () => {
    const rows = [];
    const numFmt = '#,##0.00 "₽"';

    rows.push([
      "Счёт", 
      "Сальдо нач. (Дт)", "Сальдо нач. (Кт)", 
      "Обороты (Дт)", "Обороты (Кт)", 
      "Сальдо кон. (Дт)", "Сальдо кон. (Кт)"
    ]);

    const n = (val) => ({ v: val || 0, t: 'n', z: numFmt });

    data.forEach(row => {
      rows.push([
        `${row.code} ${row.name}`,
        n(row.opening_debit), n(row.opening_credit),
        n(row.debit), n(row.credit),
        n(row.closing_debit), n(row.closing_credit)
      ]);

      if (row.children && row.children.length > 0) {
        const flatChildren = processHierarchy(row.children, infoDictionary, new Set(), row.bi_id, true);
        
        flatChildren.forEach(child => {
          const indent = "    ".repeat(child.depth);
          rows.push([
            `${indent}  └ ${child.info_name}`,
            n(child.opening_debit), n(child.opening_credit),
            n(child.debit), n(child.credit),
            n(child.closing_debit), n(child.closing_credit)
          ]);
        });
      }
    });

    rows.push([]); 
    rows.push([
      "ИТОГО",
      n(totals.opening_debit), n(totals.opening_credit),
      n(totals.debit), n(totals.credit),
      n(totals.closing_debit), n(totals.closing_credit)
    ]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "ОСВ");
    XLSX.writeFile(wb, `OSV_${filter.from}_to_${filter.to}.xlsx`);
  };

  const toggleExpand = (biId) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(biId) ? next.delete(biId) : next.add(biId)
      return next
    })
  }

  const toggleInfoExpand = (biId, infoId) => {
    setExpandedInfo(prev => {
      const next = new Set(prev)
      const key = `${biId}-${infoId}`
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const expandAll = () => {
    setExpanded(new Set(data.filter(r => r.has_analytics && r.children?.length > 0).map(r => r.bi_id)))
  }
  
  const collapseAll = () => {
    setExpanded(new Set())
    setExpandedInfo(new Set())
  }

  // --- ИСПРАВЛЕННЫЙ МЕТОД DRILL-DOWN ---
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
      const [resIn, resOut] = await Promise.all([
        getOperations({ ...params, in_bi_id: biId }),
        getOperations({ ...params, out_bi_id: biId }),
      ])
      const all = [...(resIn.data.data || []), ...(resOut.data.data || [])]
      ops = all.filter((op, idx, self) => self.findIndex(o => o.id === op.id) === idx)
    }

    if (infoId) {
      // Ищем все дочерние ID, чтобы показать операции по всей папке
      const getDescendants = (parentId) => {
        const children = infoDictionary.filter(item => item.parent_id === parentId).map(item => item.id)
        return children.reduce((acc, childId) => [...acc, ...getDescendants(childId)], children)
      }
      
      const validIds = [infoId, ...getDescendants(infoId)].map(String)

      ops = ops.filter(op =>
        (op.in_info_1_id && validIds.includes(String(op.in_info_1_id))) ||
        (op.in_info_2_id && validIds.includes(String(op.in_info_2_id))) ||
        (op.out_info_1_id && validIds.includes(String(op.out_info_1_id))) ||
        (op.out_info_2_id && validIds.includes(String(op.out_info_2_id)))
      )
    }

    ops.sort((a, b) => new Date(b.date) - new Date(a.date))
    setDrillModal({ title, ops, biId, direction, infoId })
    setDrillLoading(false)
  }

  const handleEditSaved = () => {
    setEditOp(null)
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
        
        <button 
          onClick={exportToExcel}
          disabled={loading || data.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-green-700 hover:bg-green-800 text-white rounded-lg text-sm font-medium transition-all shadow-sm active:scale-95 disabled:opacity-50"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Экспорт в Excel
        </button>
      </div>

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
              
              const flatChildren = isExpanded ? processHierarchy(row.children, infoDictionary, expandedInfo, row.bi_id) : []

              return [
                <tr key={row.bi_id}
                  className={`border-b border-gray-100 transition-colors ${hasChildren ? 'cursor-pointer hover:bg-blue-50' : 'hover:bg-gray-50'} ${isExpanded ? 'bg-blue-50' : ''}`}
                  onClick={() => hasChildren && toggleExpand(row.bi_id)}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-4 flex items-center justify-center">
                        {hasChildren && (
                          <svg 
                            className={`w-2.5 h-2.5 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} 
                            viewBox="0 0 24 24" fill="currentColor"
                          >
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </div>
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
                ...flatChildren.map(child => {
                  const hasInnerChildren = child.treeChildren && child.treeChildren.length > 0;
                  const isInfoExpanded = expandedInfo.has(`${row.bi_id}-${child.info_id}`);

                  return (
                    <tr key={`${row.bi_id}-${child.info_id}`} 
                        className={`border-b border-gray-50 transition-colors ${hasInnerChildren ? 'cursor-pointer hover:bg-blue-50/80' : 'hover:bg-blue-50/40'}`}
                        onClick={() => hasInnerChildren && toggleInfoExpand(row.bi_id, child.info_id)}
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2" style={{ paddingLeft: 32 + child.depth * 20 }}>
                          {hasInnerChildren ? (
                            <button type="button" className="text-gray-400 hover:text-gray-600 w-4 h-4 flex items-center justify-center rounded">
                              <svg 
                                className={`w-2.5 h-2.5 transition-transform duration-200 ${isInfoExpanded ? 'rotate-90' : ''}`} 
                                viewBox="0 0 24 24" fill="currentColor"
                              >
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </button>
                          ) : (
                            <span className="text-gray-300 text-xs w-4 inline-block text-center">└</span>
                          )}
                          <span className={child.depth === 0 && hasInnerChildren ? "text-xs text-gray-700 font-semibold" : "text-xs text-gray-600 font-medium"}>
                            {child.info_name}
                          </span>
                        </div>
                      </td>
                      <NumCell val={child.opening_debit}  extra="text-green-600" onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо нач. Дт`, row.bi_id, 'both', child.info_id) }} />
                      <NumCell val={child.opening_credit} extra="text-red-400"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо нач. Кт`, row.bi_id, 'both', child.info_id) }} />
                      <NumCell val={child.debit}          extra="text-green-600 border-l border-gray-100" onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — обороты Дт`, row.bi_id, 'debit', child.info_id) }} />
                      <NumCell val={child.credit}         extra="text-red-400"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — обороты Кт`, row.bi_id, 'credit', child.info_id) }} />
                      <NumCell val={child.closing_debit}  extra="text-green-600 border-l border-gray-100" onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо кон. Дт`, row.bi_id, 'both', child.info_id) }} />
                      <NumCell val={child.closing_credit} extra="text-red-400"   onClick={e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — сальдо кон. Кт`, row.bi_id, 'both', child.info_id) }} />
                    </tr>
                  )
                })
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
                          {op.table_name === 'documents' && op.table_id ? (
                            <button
                              onClick={() => { setDrillModal(null); navigate(`/documents?open=${op.table_id}`) }}
                              title="Открыть документ-источник"
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-400 hover:text-blue-600 text-xs px-1.5 py-1 rounded hover:bg-blue-50 flex items-center gap-0.5 ml-auto"
                            >
                              📄
                            </button>
                          ) : (
                            <button
                              onClick={() => setEditOp(op)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-600 text-sm p-1 rounded hover:bg-blue-50"
                            >
                              ✎
                            </button>
                          )}
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