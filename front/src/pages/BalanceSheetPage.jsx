import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import Layout from '../components/Layout'
import api from '../api/client'
import { getBalanceSheet, getBalanceItems, getOperations } from '../api/operations'
import { getDocument, postDocument, cancelDocument } from '../api/documents'
import { DocumentForm } from './DocumentsPage'
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

const fmtQty = (qty) => qty === 0 ? '—' :
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(qty)

// Остаток со знаком: debit - credit
const calcNet = (debit, credit) => (debit || 0) - (credit || 0)
const fmtNet  = (val) => {
  if (val === 0) return null
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(val)
}

const formatDate = (date) =>
  new Date(date).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })

// Бэкенд возвращает готовое дерево children[].children[].
// Разворачиваем его в плоский список с depth и признаком раскрытия.
const flattenServerTree = (nodes, expandedSet, biId, depth = 0) => {
  let result = []
  nodes.forEach(node => {
    const nodeKey = `${biId}-${node.info_id}-${node.info_type}`
    const isExp   = expandedSet.has(nodeKey)
    result.push({ ...node, depth, _key: nodeKey, _expanded: isExp })
    if (node.children?.length > 0 && isExp) {
      result = result.concat(flattenServerTree(node.children, expandedSet, biId, depth + 1))
    }
  })
  return result
}

// Разворачиваем дерево счетов (account_children) в плоский список
const flattenAccountTree = (nodes, expandedSet, depth = 0) => {
  let result = []
  nodes.forEach(node => {
    const isExp = expandedSet.has(node.bi_id)
    result.push({ ...node, _depth: depth, _expanded: isExp })
    if (node.account_children?.length > 0 && isExp) {
      result = result.concat(flattenAccountTree(node.account_children, expandedSet, depth + 1))
    }
  })
  return result
}

// Собираем все bi_id из дерева (для expandAll)
const collectAccountIds = (nodes) => {
  let ids = []
  nodes.forEach(n => {
    if (n.account_children?.length > 0) {
      ids.push(n.bi_id)
      ids = ids.concat(collectAccountIds(n.account_children))
    }
  })
  return ids
}


export default function BalanceSheetPage() {
  const navigate = useNavigate()
  const [data, setData]               = useState([])
  const [balanceItems, setBalanceItems] = useState([])
  const [projects, setProjects]         = useState([])
  const [infoDictionaries, setInfoDictionaries] = useState({})
  const [filter, setFilter]             = useState(getMonthRange())
  const [projectFilter, setProjectFilter] = useState('')
  const [infoTypes, setInfoTypes]       = useState([])
  const [hierarchyTypes, setHierarchyTypes] = useState(new Set())
  const [biFilter, setBiFilter]         = useState('')
  const [showExtraFilters, setShowExtraFilters] = useState(false)
  const [displayMode, setDisplayMode]           = useState('amount') // 'amount' | 'qty' | 'both'
  const [balanceMode, setBalanceMode]           = useState('net')    // 'net' = ±остаток | 'debit_credit' = Дт/Кт
  const [hierarchyAccounts, setHierarchyAccounts] = useState(false)
  const [expandedAccounts, setExpandedAccounts]  = useState(new Set())
  const [loading, setLoading]         = useState(false)
  const [expanded, setExpanded]       = useState(new Set())
  const [expandedInfo, setExpandedInfo] = useState(new Set())
  const [drillModal, setDrillModal]   = useState(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [editOp, setEditOp]           = useState(null)
  const dragIdx = useRef(null) // для drag-and-drop порядка аналитик

  // Состояние для инлайн-просмотра документа из drill-down
  const [docModal, setDocModal]           = useState(null)  // { doc }
  const [docActionLoading, setDocActionLoading] = useState(false)
  const [docActionError, setDocActionError]     = useState('')
  const [docInfoCache, setDocInfoCache]   = useState({})

  useEffect(() => {
    getBalanceItems().then(res => setBalanceItems(res.data.data))
    api.get('/projects')
      .then(res => {
        const list = res.data.data || res.data || []
        setProjects(list)
        if (list.length > 0) setProjectFilter(String(list[0].id))
      })
      .catch(() => {
        // /projects недоступен — работаем без фильтра проектов
      })
  }, [])

  // Загружаем справочники для всех выбранных типов аналитик
  useEffect(() => {
    infoTypes.forEach(type => {
      if (!infoDictionaries[type]) {
        getInfo({ type }).then(res =>
          setInfoDictionaries(prev => ({ ...prev, [type]: res.data.data }))
        )
      }
    })
  }, [infoTypes])

  useEffect(() => { load() }, [filter, infoTypes, biFilter, hierarchyTypes, projectFilter, hierarchyAccounts])

  const load = () => {
    setLoading(true)
    setExpanded(new Set())
    setExpandedInfo(new Set())
    setExpandedAccounts(new Set())
    const params = { date_from: filter.from, date_to: filter.to }
    if (infoTypes.length > 0)    params['info_types[]']      = infoTypes
    if (hierarchyTypes.size > 0) params['hierarchy_types[]'] = [...hierarchyTypes]
    if (biFilter)            params.bi_id               = biFilter
    if (projectFilter)       params.project_id          = projectFilter
    if (hierarchyAccounts)   params.hierarchy_accounts  = 1
    getBalanceSheet(params)
      .then(res => setData(res.data.data))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }


  // Добавить/убрать тип аналитики
  const toggleInfoType = (type) => {
    setInfoTypes(prev => {
      if (prev.includes(type)) {
        // Снимаем тип — убираем и из hierarchyTypes
        setHierarchyTypes(h => { const n = new Set(h); n.delete(type); return n })
        return prev.filter(t => t !== type)
      }
      // Добавляем тип — сразу включаем иерархию по умолчанию
      setHierarchyTypes(h => new Set([...h, type]))
      return [...prev, type]
    })
  }

  // Включить/выключить иерархию для конкретного типа
  const toggleHierarchy = (type) => {
    setHierarchyTypes(prev => {
      const next = new Set(prev)
      next.has(type) ? next.delete(type) : next.add(type)
      return next
    })
  }

  // Drag-and-drop для переупорядочивания выбранных аналитик
  const handleDragStart = (idx) => { dragIdx.current = idx }
  const handleDragOver  = (e, idx) => {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === idx) return
    setInfoTypes(prev => {
      const next = [...prev]
      const [moved] = next.splice(dragIdx.current, 1)
      next.splice(idx, 0, moved)
      dragIdx.current = idx
      return next
    })
  }
  const handleDragEnd = () => { dragIdx.current = null }

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

    const addChildRows = (nodes, depth = 0) => {
      nodes.forEach(child => {
        const indent = "    ".repeat(depth);
        const dash = { v: '—', t: 's' }
        rows.push([
          `${indent}  └ ${child.info_name}`,
          child.turnover_only ? dash : n(child.opening_debit),
          child.turnover_only ? dash : n(child.opening_credit),
          n(child.debit), n(child.credit),
          child.turnover_only ? dash : n(child.closing_debit),
          child.turnover_only ? dash : n(child.closing_credit),
        ]);
        if (child.children?.length > 0) addChildRows(child.children, depth + 1)
      })
    }

    data.forEach(row => {
      rows.push([
        `${row.code} ${row.name}`,
        n(row.opening_debit), n(row.opening_credit),
        n(row.debit), n(row.credit),
        n(row.closing_debit), n(row.closing_credit)
      ]);
      if (row.children?.length > 0) addChildRows(row.children, 0)
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

  const expandAllAccounts = () => setExpandedAccounts(new Set(collectAccountIds(data)))
  const collapseAllAccounts = () => setExpandedAccounts(new Set())

  const toggleAccount = (biId) => setExpandedAccounts(prev => {
    const next = new Set(prev)
    next.has(biId) ? next.delete(biId) : next.add(biId)
    return next
  })

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
      // Объединяем все загруженные справочники для поиска дочерних элементов
      const allInfoItems = Object.values(infoDictionaries).flat()
      const getDescendants = (parentId) => {
        const children = allInfoItems.filter(item => item.parent_id === parentId).map(item => item.id)
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

  // Открываем документ инлайн из drill-down (не уходя со страницы)
  const openDocumentModal = async (tableId) => {
    try {
      const r = await getDocument(tableId)
      setDocModal({ doc: r.data.data })
    } catch {
      // если не получилось — ничего
    }
  }

  // После любого действия с документом — закрываем docModal,
  // обновляем ОСВ и перезагружаем список операций в drill-down
  const refreshAfterDocAction = () => {
    setDocModal(null)
    load()
    if (drillModal) {
      openDrill(drillModal.title, drillModal.biId, drillModal.direction, drillModal.infoId)
    }
  }

  const handleDocSaved = () => {
    refreshAfterDocAction()
  }

  const handleDocPost = async (doc) => {
    setDocActionLoading(true)
    setDocActionError('')
    try {
      await postDocument(doc.id)
      const r = await getDocument(doc.id)
      setDocModal({ doc: r.data.data })
      load()
      if (drillModal) {
        openDrill(drillModal.title, drillModal.biId, drillModal.direction, drillModal.infoId)
      }
    } catch (err) {
      setDocActionError(err.response?.data?.message || 'Ошибка проведения')
      setTimeout(() => setDocActionError(''), 4000)
    } finally {
      setDocActionLoading(false)
    }
  }

  const handleDocCancel = async (doc) => {
    setDocActionLoading(true)
    setDocActionError('')
    try {
      await cancelDocument(doc.id)
      const r = await getDocument(doc.id)
      setDocModal({ doc: r.data.data })
      load()
      if (drillModal) {
        openDrill(drillModal.title, drillModal.biId, drillModal.direction, drillModal.infoId)
      }
    } catch (err) {
      setDocActionError(err.response?.data?.message || 'Ошибка отмены проведения')
      setTimeout(() => setDocActionError(''), 4000)
    } finally {
      setDocActionLoading(false)
    }
  }

  const loadDocInfo = (type) => {
    getInfo({ type }).then(r => setDocInfoCache(c => ({ ...c, [type]: r.data.data })))
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

  // Ячейка суммы — кликабельна для drill-down
  const AmtCell = ({ val, onClick, extra = '' }) => (
    <td className={`px-3 py-2.5 text-right text-xs font-medium whitespace-nowrap ${extra}`}>
      {val === 0 ? <span className="text-gray-300">—</span> : (
        <button onClick={onClick} className="hover:underline hover:opacity-75 transition-opacity cursor-pointer">
          {fmt(val)}
        </button>
      )}
    </td>
  )

  // Ячейка количества — кликабельна если есть onClick
  const QtyCell = ({ val, onClick, extra = '' }) => (
    <td className={`px-3 py-2.5 text-right text-xs whitespace-nowrap text-blue-600 ${extra}`}>
      {val === 0 ? <span className="text-gray-200">—</span> : onClick ? (
        <button onClick={onClick} className="hover:underline hover:opacity-75 transition-opacity cursor-pointer">
          {fmtQty(val)}
        </button>
      ) : fmtQty(val)}
    </td>
  )

  // Ячейка-прочерк для сальдо при turnover_only — сальдо не имеет смысла
  const DashCell = ({ borderLeft = false }) => (
    <td className={`px-3 py-2.5 text-right text-xs text-gray-300 whitespace-nowrap ${borderLeft ? 'border-l border-gray-100' : ''}`}>
      —
    </td>
  )

  // Ячейка остатка со знаком (±)
  // В режиме qty — только количество, в amount — только сумма, в both — оба
  const NetCell = ({ debit, credit, qtyDebit, qtyCredit, hasQty, onClick, borderLeft = false }) => {
    const net    = calcNet(debit, credit)
    const netQty = hasQty ? calcNet(qtyDebit ?? 0, qtyCredit ?? 0) : 0
    const bl     = borderLeft ? 'border-l border-gray-100' : ''

    // Что показываем основным значением
    const showQtyOnly = displayMode === 'qty'
    const showAmt     = displayMode !== 'qty'   // amount или both
    const showQtySub  = displayMode === 'both' && hasQty  // количество под суммой

    const mainVal   = showQtyOnly ? netQty : net
    const mainFmt   = showQtyOnly
      ? (netQty === 0 ? null : fmtQty(Math.abs(netQty)) + (netQty < 0 ? ' ↓' : ' ↑'))
      : fmtNet(net)
    const mainColor = mainVal > 0 ? 'text-green-700' : mainVal < 0 ? 'text-red-600' : 'text-gray-300'

    return (
      <td className={`px-3 py-2.5 text-right text-xs font-medium whitespace-nowrap ${mainColor} ${bl}`}>
        {mainFmt === null ? <span className="text-gray-300">—</span> : (
          <button onClick={onClick} className="hover:underline hover:opacity-75 transition-opacity cursor-pointer">
            {mainFmt}
          </button>
        )}
        {showQtySub && (
          <div className={`text-[10px] ${netQty > 0 ? 'text-green-500' : netQty < 0 ? 'text-red-400' : 'text-gray-200'}`}>
            {netQty === 0 ? '—' : fmtQty(Math.abs(netQty)) + (netQty < 0 ? ' ↓' : ' ↑')}
          </div>
        )}
      </td>
    )
  }

  // Рендерим группу ячеек в зависимости от balanceMode + displayMode
  // hasQty — есть ли количественный учёт у этого счёта/строки
  // turnoverOnly — если true, сальдо нач/кон заменяются прочерком
  const renderCells = (row, hasQty, onClickDt, onClickKt, borderLeft = false, turnoverOnly = false) => {
    const bl  = borderLeft ? 'border-l border-gray-100' : ''
    const isTO = turnoverOnly || !!row.turnover_only

    // ── Режим ± (остаток со знаком) ────────────────────────────────────────
    if (balanceMode === 'net') {
      return <>
        {isTO
          ? <DashCell />
          : <NetCell
              debit={row.opening_debit} credit={row.opening_credit}
              qtyDebit={row.qty_opening} qtyCredit={row.qty_opening_neg}
              hasQty={hasQty} onClick={onClickDt}
            />
        }
        {displayMode === 'qty' ? <>
          <QtyCell val={hasQty ? (row.qty_debit  ?? 0) : 0} extra={`text-green-600 ${bl}`} onClick={hasQty ? onClickDt : undefined} />
          <QtyCell val={hasQty ? (row.qty_credit ?? 0) : 0} extra="text-red-500"            onClick={hasQty ? onClickKt : undefined} />
        </> : displayMode === 'both' ? <>
          <td className={`px-3 py-2 text-right text-xs whitespace-nowrap text-green-700 ${bl}`}>
            <button onClick={onClickDt} className="hover:underline block w-full">{row.debit === 0 ? <span className="text-gray-300">—</span> : fmt(row.debit)}</button>
            {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_debit ?? 0)}</span>}
          </td>
          <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-red-600">
            <button onClick={onClickKt} className="hover:underline block w-full">{row.credit === 0 ? <span className="text-gray-300">—</span> : fmt(row.credit)}</button>
            {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_credit ?? 0)}</span>}
          </td>
        </> : <>
          <AmtCell val={row.debit}  extra={`text-green-700 ${bl}`} onClick={onClickDt} />
          <AmtCell val={row.credit} extra="text-red-600"           onClick={onClickKt} />
        </>}
        {isTO
          ? <DashCell borderLeft />
          : <NetCell
              debit={row.closing_debit} credit={row.closing_credit}
              qtyDebit={row.qty_closing} qtyCredit={row.qty_closing_neg}
              hasQty={hasQty} onClick={onClickDt} borderLeft
            />
        }
      </>
    }
    if (displayMode === 'amount') {
      return <>
        {isTO ? <DashCell /> : <AmtCell val={row.opening_debit}  extra="text-green-700" onClick={onClickDt} />}
        {isTO ? <DashCell /> : <AmtCell val={row.opening_credit} extra="text-red-600"   onClick={onClickKt} />}
        <AmtCell val={row.debit}  extra={`text-green-700 ${bl}`} onClick={onClickDt} />
        <AmtCell val={row.credit} extra="text-red-600"           onClick={onClickKt} />
        {isTO ? <DashCell borderLeft /> : <AmtCell val={row.closing_debit}  extra={`text-green-700 ${bl}`} onClick={onClickDt} />}
        {isTO ? <DashCell />            : <AmtCell val={row.closing_credit} extra="text-red-600"           onClick={onClickKt} />}
      </>
    }
    if (displayMode === 'qty') {
      return <>
        {isTO ? <DashCell /> : <QtyCell val={hasQty ? (row.qty_opening    ?? 0) : 0} extra="text-green-600" onClick={hasQty ? onClickDt : undefined} />}
        {isTO ? <DashCell /> : <QtyCell val={hasQty ? (row.qty_opening_neg ?? 0) : 0} extra="text-red-500"  onClick={hasQty ? onClickKt : undefined} />}
        <QtyCell val={hasQty ? (row.qty_debit      ?? 0) : 0} extra={`text-green-600 ${bl}`} onClick={hasQty ? onClickDt : undefined} />
        <QtyCell val={hasQty ? (row.qty_credit     ?? 0) : 0} extra="text-red-500"           onClick={hasQty ? onClickKt : undefined} />
        {isTO ? <DashCell borderLeft /> : <QtyCell val={hasQty ? (row.qty_closing    ?? 0) : 0} extra={`text-green-600 ${bl}`} onClick={hasQty ? onClickDt : undefined} />}
        {isTO ? <DashCell />            : <QtyCell val={hasQty ? (row.qty_closing_neg ?? 0) : 0} extra="text-red-500"           onClick={hasQty ? onClickKt : undefined} />}
      </>
    }
    // both — два ряда в одной ячейке
    return <>
      {isTO ? <DashCell /> : (
        <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-green-700">
          <button onClick={onClickDt} className="hover:underline block w-full">{row.opening_debit === 0 ? <span className="text-gray-300">—</span> : fmt(row.opening_debit)}</button>
          {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_opening ?? 0)}</span>}
        </td>
      )}
      {isTO ? <DashCell /> : (
        <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-red-600">
          <button onClick={onClickKt} className="hover:underline block w-full">{row.opening_credit === 0 ? <span className="text-gray-300">—</span> : fmt(row.opening_credit)}</button>
          {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_opening_neg ?? 0)}</span>}
        </td>
      )}
      <td className={`px-3 py-2 text-right text-xs whitespace-nowrap text-green-700 ${bl}`}>
        <button onClick={onClickDt} className="hover:underline block w-full">{row.debit === 0 ? <span className="text-gray-300">—</span> : fmt(row.debit)}</button>
        {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_debit ?? 0)}</span>}
      </td>
      <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-red-600">
        <button onClick={onClickKt} className="hover:underline block w-full">{row.credit === 0 ? <span className="text-gray-300">—</span> : fmt(row.credit)}</button>
        {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_credit ?? 0)}</span>}
      </td>
      {isTO ? <DashCell borderLeft /> : (
        <td className={`px-3 py-2 text-right text-xs whitespace-nowrap text-green-700 ${bl}`}>
          <button onClick={onClickDt} className="hover:underline block w-full">{row.closing_debit === 0 ? <span className="text-gray-300">—</span> : fmt(row.closing_debit)}</button>
          {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_closing ?? 0)}</span>}
        </td>
      )}
      {isTO ? <DashCell /> : (
        <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-red-600">
          <button onClick={onClickKt} className="hover:underline block w-full">{row.closing_credit === 0 ? <span className="text-gray-300">—</span> : fmt(row.closing_credit)}</button>
          {hasQty && <span className="text-blue-500 text-[10px]">{fmtQty(row.qty_closing_neg ?? 0)}</span>}
        </td>
      )}
    </>
  }

  return (
    <Layout>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-semibold text-gray-800">Оборотно-сальдовая ведомость</h2>

        <div className="flex items-center gap-3">
          {/* Переключатель остаток/Дт+Кт */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
            {[
              { key: 'net',          label: '±',     title: 'Остаток со знаком' },
              { key: 'debit_credit', label: 'Дт/Кт', title: 'Дебет и кредит раздельно' },
            ].map(m => (
              <button key={m.key} type="button" title={m.title}
                onClick={() => setBalanceMode(m.key)}
                className={`px-3 py-1.5 transition-colors ${
                  balanceMode === m.key ? 'bg-blue-900 text-white' : 'text-gray-500 hover:bg-gray-50'
                }`}>
                {m.label}
              </button>
            ))}
          </div>

          {/* Иерархия счетов */}
          <button type="button"
            onClick={() => setHierarchyAccounts(v => !v)}
            title={hierarchyAccounts ? 'Иерархия счетов включена' : 'Плоский список счетов'}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              hierarchyAccounts
                ? 'bg-blue-900 text-white border-blue-900'
                : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
            }`}>
            <span>⊟</span>
            <span>Счета</span>
          </button>

          {/* Переключатель Σ / # / Σ+# */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
            {[
              { key: 'amount', label: 'Σ',   title: 'Только суммы' },
              { key: 'qty',    label: '#',   title: 'Только количество' },
              { key: 'both',   label: 'Σ+#', title: 'Суммы и количество' },
            ].map(m => (
              <button key={m.key} type="button" title={m.title}
                onClick={() => setDisplayMode(m.key)}
                className={`px-3 py-1.5 transition-colors ${
                  displayMode === m.key
                    ? 'bg-blue-900 text-white'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}>
                {m.label}
              </button>
            ))}
          </div>

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
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4 space-y-2">

        {/* ── Строка 1: период + дата + кнопка ⋯ + загрузка ── */}
        <div className="flex items-center gap-3 flex-wrap">
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
          <span className="text-gray-300">|</span>
          {/* Кнопка доп. фильтров */}
          <button
            onClick={() => setShowExtraFilters(v => !v)}
            title="Проект и счёт"
            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
              showExtraFilters || biFilter || (projects.length > 1 && projectFilter)
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
            }`}>
            ⋯
            {(biFilter || (projects.length > 1 && projectFilter)) && (
              <span className="ml-1 text-blue-500">•</span>
            )}
          </button>
          {loading && <span className="text-xs text-gray-400">Загрузка...</span>}
        </div>

        {/* ── Панель доп. фильтров (проект + счёт) ── */}
        {showExtraFilters && (
          <div className="flex items-center gap-4 flex-wrap pt-2 border-t border-gray-100">
            {/* Проект — только если больше одного */}
            {projects.length > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 font-medium">Проект:</span>
                <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)}
                  className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-40">
                  <option value="">Все проекты</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
            {/* Счёт */}
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
            {(biFilter || projectFilter) && (
              <button onClick={() => { setBiFilter(''); setProjectFilter(projects[0]?.id ? String(projects[0].id) : '') }}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                × сбросить
              </button>
            )}
          </div>
        )}

        {/* ── Строка 2: аналитика ── */}
        <div className="flex items-start gap-2 flex-wrap pt-1">
          <span className="text-xs text-gray-500 font-medium mt-1.5">Аналитика:</span>
          <div className="flex flex-wrap gap-1.5">
            {INFO_TYPES.filter(t => t.value).map(t => {
              const selected = infoTypes.includes(t.value)
              const order    = infoTypes.indexOf(t.value)
              return (
                <button key={t.value} type="button"
                  onClick={() => toggleInfoType(t.value)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    selected
                      ? 'bg-blue-900 text-white border-blue-900'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-blue-400 hover:text-blue-600'
                  }`}>
                  {selected && <span className="mr-1 opacity-60">{order + 1}.</span>}
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Строка 3: порядок аналитик + управление раскрытием ── */}
        {(infoTypes.length > 0 || hierarchyAccounts) && (
          <div className="flex items-center gap-3 flex-wrap">
            {/* Пилюли аналитик */}
            {infoTypes.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {infoTypes.map((type, idx) => {
                  const label  = INFO_TYPES.find(t => t.value === type)?.label || type
                  const isHier = hierarchyTypes.has(type)
                  return (
                    <div key={type}
                      draggable
                      onDragStart={() => handleDragStart(idx)}
                      onDragOver={e => handleDragOver(e, idx)}
                      onDragEnd={handleDragEnd}
                      className="flex items-center gap-0 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700 select-none overflow-hidden">
                      <div className="flex items-center gap-1 px-2.5 py-1 cursor-grab active:cursor-grabbing">
                        <span className="text-blue-300">⠿</span>
                        {infoTypes.length > 1 && <span className="font-medium">{idx + 1}.</span>}
                        <span>{label}</span>
                      </div>
                      <div className="w-px h-5 bg-blue-200" />
                      <button type="button" onClick={() => toggleHierarchy(type)}
                        title={isHier ? 'Иерархия — нажмите для плоского' : 'Плоско — нажмите для иерархии'}
                        className={`px-2 py-1 transition-colors ${isHier ? 'bg-blue-900 text-white' : 'text-blue-400 hover:text-blue-700 hover:bg-blue-100'}`}>
                        {isHier ? '⊞' : '≡'}
                      </button>
                    </div>
                  )
                })}
                {infoTypes.length > 1 && (
                  <span className="text-xs text-gray-400 self-center">← перетащите для порядка</span>
                )}
              </div>
            )}

            {/* Разделитель если есть и аналитика и иерархия счетов */}
            {infoTypes.length > 0 && hierarchyAccounts && (
              <span className="text-gray-300">|</span>
            )}

            {/* Раскрыть/свернуть счета */}
            {hierarchyAccounts && collectAccountIds(data).length > 0 && (
              <>
                <button onClick={expandAllAccounts}   className="text-xs text-blue-600 hover:underline">Раскрыть счета</button>
                <button onClick={collapseAllAccounts} className="text-xs text-gray-400 hover:underline">Свернуть счета</button>
              </>
            )}

            {/* Раскрыть/свернуть аналитику */}
            {infoTypes.length > 0 && data.filter(r => r.has_analytics && r.children?.length > 0).length > 0 && (
              <>
                <span className="text-gray-300">|</span>
                <button onClick={expandAll}   className="text-xs text-blue-600 hover:underline">Раскрыть аналитику</button>
                <button onClick={collapseAll} className="text-xs text-gray-400 hover:underline">Свернуть аналитику</button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-r border-gray-200" rowSpan={2}>Счёт</th>
              {balanceMode === 'net' ? <>
                <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100">Остаток нач.</th>
                <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100 border-l border-gray-200" colSpan={2}>Обороты за период</th>
                <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100 border-l border-gray-200">Остаток кон.</th>
              </> : <>
                <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100" colSpan={2}>Сальдо начальное</th>
                <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100 border-l border-gray-200" colSpan={2}>Обороты за период</th>
                <th className="text-center px-4 py-2 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100 border-l border-gray-200" colSpan={2}>Сальдо конечное</th>
              </>}
            </tr>
            <tr className="bg-gray-50 border-b border-gray-200">
              {balanceMode === 'net' ? <>
                <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium border-l border-gray-200">{displayMode === 'qty' ? '# ±' : '±'}</th>
                <th className="text-right px-3 py-2 text-xs text-green-600 font-medium border-l border-gray-200">{displayMode === 'qty' ? '# Дт' : 'Дт'}</th>
                <th className="text-right px-3 py-2 text-xs text-red-500 font-medium">{displayMode === 'qty' ? '# Кт' : 'Кт'}</th>
                <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium border-l border-gray-200">{displayMode === 'qty' ? '# ±' : '±'}</th>
              </> : displayMode === 'qty' ? <>
                <th className="text-right px-3 py-2 text-xs text-green-600 font-medium border-l border-gray-200"># Дт</th>
                <th className="text-right px-3 py-2 text-xs text-red-500 font-medium"># Кт</th>
                <th className="text-right px-3 py-2 text-xs text-green-600 font-medium border-l border-gray-200"># Дт</th>
                <th className="text-right px-3 py-2 text-xs text-red-500 font-medium"># Кт</th>
                <th className="text-right px-3 py-2 text-xs text-green-600 font-medium border-l border-gray-200"># Дт</th>
                <th className="text-right px-3 py-2 text-xs text-red-500 font-medium"># Кт</th>
              </> : <>
                <th className="text-right px-3 py-2 text-xs text-green-600 font-medium border-l border-gray-200">Дебет</th>
                <th className="text-right px-3 py-2 text-xs text-red-500 font-medium">Кредит</th>
                <th className="text-right px-3 py-2 text-xs text-green-600 font-medium border-l border-gray-200">Дебет</th>
                <th className="text-right px-3 py-2 text-xs text-red-500 font-medium">Кредит</th>
                <th className="text-right px-3 py-2 text-xs text-green-600 font-medium border-l border-gray-200">Дебет</th>
                <th className="text-right px-3 py-2 text-xs text-red-500 font-medium">Кредит</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 && !loading ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Нет данных за выбранный период</td></tr>
            ) : (hierarchyAccounts ? flattenAccountTree(data, expandedAccounts) : data).map(row => {
              const depth       = row._depth ?? 0
              const hasAccChildren = row.account_children?.length > 0
              const isAccExpanded  = row._expanded ?? false
              const hasChildren = row.has_analytics && row.children?.length > 0
              const isExpanded  = expanded.has(row.bi_id)
              const flatChildren = isExpanded ? flattenServerTree(row.children || [], expandedInfo, row.bi_id) : []
              // Строки-агрегаторы (родительские счета без собственных данных) — серый фон
              const isAggregate = hierarchyAccounts && hasAccChildren

              return [
                <tr key={`acc-${row.bi_id}`}
                  className={`border-b border-gray-100 transition-colors hover:bg-gray-50 ${isAggregate ? 'bg-gray-50/60' : ''} ${isExpanded ? 'bg-blue-50' : ''}`}
                >
                  <td className="px-4 py-2.5 border-r border-gray-200">
                    <div className="flex items-center gap-1" style={{ paddingLeft: depth * 20 }}>
                      {/* Кнопка раскрытия дочерних счетов */}
                      <div className="w-4 flex items-center justify-center flex-shrink-0">
                        {hasAccChildren ? (
                          <button type="button" onClick={() => toggleAccount(row.bi_id)}
                            className="text-gray-400 hover:text-gray-600 transition-colors">
                            <svg className={`w-2.5 h-2.5 transition-transform duration-200 ${isAccExpanded ? 'rotate-90' : ''}`}
                              viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>
                        ) : (
                          depth > 0 ? <span className="text-gray-200 text-xs">└</span> : null
                        )}
                      </div>
                      {/* Кнопка раскрытия аналитики */}
                      <div className="w-4 flex items-center justify-center flex-shrink-0">
                        {hasChildren && (
                          <button type="button" onClick={() => toggleExpand(row.bi_id)}
                            className="text-gray-400 hover:text-blue-500 transition-colors">
                            <svg className={`w-2.5 h-2.5 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                              viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <span className={`font-mono text-xs font-semibold ${isAggregate ? 'text-gray-500' : 'text-gray-700'}`}>
                        {row.code}
                      </span>
                      <span className={`text-xs ml-1 ${isAggregate ? 'text-gray-400 font-medium' : 'text-gray-500'}`}>
                        {row.name?.replace(/^[А-ЯA-Z]\d+\s/, '')}
                      </span>
                    </div>
                  </td>
                  {renderCells(
                    row, row.has_quantity,
                    e => { e.stopPropagation(); openDrill(`${row.code} — Дт`, row.bi_id, 'debit') },
                    e => { e.stopPropagation(); openDrill(`${row.code} — Кт`, row.bi_id, 'credit') },
                    true
                  )}
                </tr>,
                ...flatChildren.map(child => {
                  const hasInnerChildren = child.children?.length > 0
                  const isInfoExpanded   = child._expanded

                  return (
                    <tr key={child._key}
                        className={`border-b border-gray-50 transition-colors ${hasInnerChildren ? 'cursor-pointer hover:bg-blue-50/80' : 'hover:bg-blue-50/40'}`}
                        onClick={() => hasInnerChildren && setExpandedInfo(prev => {
                          const next = new Set(prev)
                          next.has(child._key) ? next.delete(child._key) : next.add(child._key)
                          return next
                        })}
                    >
                      <td className="px-4 py-2 border-r border-gray-200">
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
                          <div>
                            <span className={child.depth === 0 && hasInnerChildren ? "text-xs text-gray-700 font-semibold" : "text-xs text-gray-600 font-medium"}>
                              {child.info_name}
                            </span>
                            {infoTypes.length > 1 && (
                              <span className="ml-1.5 text-[10px] text-gray-300">
                                {INFO_TYPES.find(t => t.value === child.info_type)?.label}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      {renderCells(
                        child, row.has_quantity,
                        e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — Дт`, row.bi_id, 'debit', child.info_id) },
                        e => { e.stopPropagation(); openDrill(`${row.code} / ${child.info_name} — Кт`, row.bi_id, 'credit', child.info_id) },
                        true,
                        child.turnover_only
                      )}
                    </tr>
                  )
                })
              ]
            })}
          </tbody>
          {data.length > 0 && (
            <tfoot>
              <tr className="bg-gray-50 border-t-2 border-gray-200">
                <td className="px-4 py-2.5 text-xs font-bold text-gray-700 pl-9 border-r border-gray-200">Итого</td>
                {balanceMode === 'net' ? <>
                  {(() => {
                    const net    = calcNet(totals.opening_debit, totals.opening_credit)
                    const netCls = net > 0 ? 'text-green-700' : net < 0 ? 'text-red-600' : 'text-gray-400'
                    const netE   = calcNet(totals.closing_debit, totals.closing_credit)
                    const netECls= netE > 0 ? 'text-green-700' : netE < 0 ? 'text-red-600' : 'text-gray-400'
                    return <>
                      <td className={`px-3 py-2.5 text-right text-xs font-bold ${netCls}`}>{fmtNet(net) ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right text-xs font-bold text-green-700 border-l border-gray-100">{fmt(totals.debit)}</td>
                      <td className="px-3 py-2.5 text-right text-xs font-bold text-red-600">{fmt(totals.credit)}</td>
                      <td className={`px-3 py-2.5 text-right text-xs font-bold ${netECls} border-l border-gray-100`}>{fmtNet(netE) ?? '—'}</td>
                    </>
                  })()}
                </> : displayMode === 'qty' ? <>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-green-700">—</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-red-600">—</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-green-700 border-l border-gray-100">—</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-red-600">—</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-green-700 border-l border-gray-100">—</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-red-600">—</td>
                </> : <>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-green-700">{fmt(totals.opening_debit)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-red-600">{fmt(totals.opening_credit)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-green-700 border-l border-gray-100">{fmt(totals.debit)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-red-600">{fmt(totals.credit)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-green-700 border-l border-gray-100">{fmt(totals.closing_debit)}</td>
                  <td className="px-3 py-2.5 text-right text-xs font-bold text-red-600">{fmt(totals.closing_credit)}</td>
                </>}
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
                      <th className="text-right px-4 py-3 text-blue-500">#</th>
                      <th className="text-left px-4 py-3">Содержание</th>
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
                        <td className="px-4 py-3 text-right text-xs text-blue-600 whitespace-nowrap">
                          {op.quantity ? fmtQty(op.quantity) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">{op.note || op.content || '—'}</td>
                        <td className="px-4 py-3 text-right">
                          {op.table_name === 'documents' && op.table_id ? (
                            <button
                              onClick={() => openDocumentModal(op.table_id)}
                              title="Открыть документ"
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            </button>
                          ) : (
                            <button
                              onClick={() => setEditOp(op)}
                              title="Редактировать"
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
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
                      <td colSpan={3}></td>
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

      {/* Инлайн-просмотр/редактирование документа из drill-down */}
      {docModal && (
        <>
          {docActionError && (
            <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg shadow-lg">
              {docActionError}
            </div>
          )}
          <DocumentForm
            docType={docModal.doc.type}
            doc={docModal.doc}
            balanceItems={balanceItems}
            infoCache={docInfoCache}
            loadInfo={loadDocInfo}
            onSave={handleDocSaved}
            onCancel={refreshAfterDocAction}
            onPost={handleDocPost}
            onCancelDoc={handleDocCancel}
          />
        </>
      )}
    </Layout>
  )
}