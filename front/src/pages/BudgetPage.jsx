import { Fragment, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  getBudgetDocuments, createBudgetDocument,
  getBudgetReport, createBudgetItem, updateBudgetItem, deleteBudgetItem, upsertOpeningBalance,
} from '../api/budget'
import Layout from '../components/Layout'

// ── Утилиты ────────────────────────────────────────────────────────────────
const fmt = (v) => { if (v == null || v === '' || isNaN(v)) return ''; return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) }
const monthLabel = (ds) => new Date(ds + 'T00:00:00').toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
const isCurrentMonth = (ds) => { const n = new Date(), d = new Date(ds + 'T00:00:00'); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() }
const isFutureMonth = (ds) => new Date(ds + 'T00:00:00') > new Date(new Date().getFullYear(), new Date().getMonth(), 1)

// ── Дерево ─────────────────────────────────────────────────────────────────
const flattenArticles = (articles, depth = 0) => {
  const r = []; for (const a of articles) { r.push({ ...a, depth, hasChildren: !!(a.children?.length) }); if (a.children) r.push(...flattenArticles(a.children, depth + 1)) }; return r
}
const buildDescendantLeafMap = (articles) => {
  const map = {}; const collect = (n) => { if (!n.children?.length) { map[n.id] = new Set([n.id]); return map[n.id] }; const s = new Set(); for (const c of n.children) for (const l of collect(c)) s.add(l); map[n.id] = s; return s }
  for (const a of articles) collect(a); return map
}

// ── Дельта ─────────────────────────────────────────────────────────────────
function DeltaCell({ fact, plan }) {
  if (fact == null || !plan) return <td className="px-1 py-1.5 text-right text-[10px]" />
  let displayPct, isGood
  if (plan < 0) { const ad = Math.abs(fact) - Math.abs(plan); displayPct = Math.round((ad / Math.abs(plan)) * 100); isGood = displayPct < 0 }
  else { displayPct = Math.round(((fact - plan) / Math.abs(plan)) * 100); isGood = displayPct > 0 }
  if (!isFinite(displayPct) || displayPct === 0) return <td className="px-1 py-1.5 text-right text-[10px] text-gray-400">0%</td>
  return <td className={`px-1 py-1.5 text-right text-[10px] tabular-nums ${isGood ? 'text-emerald-600' : 'text-red-500'}`}>{displayPct > 0 ? '+' : ''}{displayPct}%</td>
}

// ── Ячейка плана (простая, без dropdown) ────────────────────────────────────
function PlanCell({ value, detailCount, disabled, onClick }) {
  const title = detailCount > 1 ? `${detailCount} строк плана` : detailCount === 1 ? '1 строка плана' : 'Нажмите для ввода'
  return (
    <td className={`px-2 py-1.5 text-right text-xs tabular-nums border-l border-gray-100 ${disabled ? 'text-blue-400' : 'text-blue-600 cursor-pointer hover:bg-blue-50'}`}
      onClick={disabled ? undefined : onClick} title={title}>
      {fmt(value)}
    </td>
  )
}

// ── Простая ячейка плана для остатков ────────────────────────────────────────
function PlanCellSimple({ value, onSave, disabled }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(''); const ref = useRef(null)
  const startEdit = () => { if (disabled) return; setText(value ? String(Math.round(value)) : ''); setEditing(true) }
  useEffect(() => { if (editing && ref.current) ref.current.focus() }, [editing])
  const commit = () => { setEditing(false); const n = parseFloat(text.replace(/\s/g, '').replace(',', '.')) || 0; if (n !== (value || 0)) onSave(n) }
  if (editing) return <td className="px-1 py-0.5"><input ref={ref} type="text" className="w-full text-right text-xs px-2 py-1 border border-blue-300 rounded bg-white text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-200" value={text} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }} /></td>
  return <td className={`px-2 py-1.5 text-right text-xs tabular-nums ${disabled ? 'text-blue-400' : 'text-blue-600 cursor-pointer hover:bg-blue-50 rounded'}`} onDoubleClick={startEdit}>{fmt(value)}</td>
}

// ── Drawer: боковая панель редактирования ────────────────────────────────────
function PlanDrawer({ articleName, periodLabel, details, articleId, periodDate, docId, onClose, onUpdate }) {
  const [rows, setRows] = useState(details || [])
  const [adding, setAdding] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const contentRef = useRef(null)

  useEffect(() => setRows(details || []), [details])
  useEffect(() => { if (adding && contentRef.current) contentRef.current.focus() }, [adding])

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)

  const handleAdd = async () => {
    const amount = parseFloat(newAmount.replace(/\s/g, '').replace(',', '.')) || 0
    if (!amount && !newContent.trim()) return
    setSaving(true)
    try {
      const res = await createBudgetItem({ budget_document_id: docId, article_id: articleId, period_date: periodDate, content: newContent.trim() || null, amount })
      setRows(prev => [...prev, res.data.data])
      setNewContent(''); setNewAmount('')
      if (contentRef.current) contentRef.current.focus()
      onUpdate()
    } finally { setSaving(false) }
  }

  const handleRowUpdate = async (item, updates) => {
    const data = { content: updates.content ?? item.content, amount: updates.amount ?? item.amount }
    await updateBudgetItem(item.id, data)
    setRows(prev => prev.map(r => r.id === item.id ? { ...r, ...data } : r))
    onUpdate()
  }

  const handleDelete = async (item) => {
    await deleteBudgetItem(item.id)
    setRows(prev => prev.filter(r => r.id !== item.id))
    onUpdate()
  }

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-[420px] max-w-full bg-white shadow-2xl z-50 flex flex-col border-l border-gray-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-gray-800">Детализация плана</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
          </div>
          <div className="text-xs text-gray-500">{articleName}</div>
          <div className="text-xs text-gray-400">{periodLabel}</div>
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {rows.length === 0 && !adding && (
            <div className="text-center py-8 text-gray-400 text-sm">Нет строк плана</div>
          )}
          <div className="space-y-2">
            {rows.map(item => (
              <DrawerRow key={item.id} item={item} onUpdate={handleRowUpdate} onDelete={handleDelete} />
            ))}
          </div>

          {/* Форма добавления */}
          {adding ? (
            <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
              <div className="space-y-2">
                <input ref={contentRef} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white" placeholder="Описание (необязательно)"
                  value={newContent} onChange={e => setNewContent(e.target.value)} />
                <input className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white text-right" placeholder="Сумма"
                  value={newAmount} onChange={e => setNewAmount(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') { setAdding(false); setNewContent(''); setNewAmount('') } }} />
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={handleAdd} disabled={saving} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {saving ? '...' : 'Добавить'}
                </button>
                <button onClick={() => { setAdding(false); setNewContent(''); setNewAmount('') }} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg">Отмена</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="mt-3 w-full py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg border border-dashed border-blue-200 transition-colors">
              + Добавить строку
            </button>
          )}
        </div>

        {/* Footer с итогом */}
        <div className="px-5 py-3 border-t border-gray-100 flex-shrink-0 bg-gray-50">
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">Итого ({rows.length} {rows.length === 1 ? 'строка' : rows.length < 5 ? 'строки' : 'строк'})</span>
            <span className="text-sm font-semibold text-blue-700 tabular-nums">{fmt(total)}</span>
          </div>
        </div>
      </div>
    </>
  )
}

function DrawerRow({ item, onUpdate, onDelete }) {
  const [editContent, setEditContent] = useState(false)
  const [editAmount, setEditAmount] = useState(false)
  const [text, setText] = useState('')
  const ref = useRef(null)

  useEffect(() => { if ((editContent || editAmount) && ref.current) ref.current.focus() }, [editContent, editAmount])

  const commitContent = () => { setEditContent(false); onUpdate(item, { content: text }) }
  const commitAmount = () => { setEditAmount(false); const n = parseFloat(text.replace(/\s/g, '').replace(',', '.')) || 0; onUpdate(item, { amount: n }) }

  return (
    <div className="group p-3 bg-white rounded-lg border border-gray-100 hover:border-gray-200 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {editContent ? (
            <input ref={ref} className="w-full px-2 py-1 border border-blue-300 rounded text-sm"
              value={text} onChange={e => setText(e.target.value)} onBlur={commitContent}
              onKeyDown={e => { if (e.key === 'Enter') commitContent(); if (e.key === 'Escape') setEditContent(false) }} />
          ) : (
            <div className="text-sm text-gray-700 cursor-pointer hover:text-blue-600 truncate"
              onClick={() => { setText(item.content || ''); setEditContent(true) }}>
              {item.content || <span className="text-gray-300 italic">без описания — нажмите для ввода</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {editAmount ? (
            <input ref={ref} className="w-24 px-2 py-1 border border-blue-300 rounded text-sm text-right"
              value={text} onChange={e => setText(e.target.value)} onBlur={commitAmount}
              onKeyDown={e => { if (e.key === 'Enter') commitAmount(); if (e.key === 'Escape') setEditAmount(false) }} />
          ) : (
            <div className="text-sm font-medium text-blue-600 tabular-nums cursor-pointer hover:text-blue-800"
              onClick={() => { setText(String(Math.round(item.amount))); setEditAmount(true) }}>
              {fmt(item.amount)}
            </div>
          )}
          <button onClick={() => onDelete(item)} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity text-sm">&times;</button>
        </div>
      </div>
    </div>
  )
}

// ── Модалка создания ────────────────────────────────────────────────────────
function CreateDocModal({ projects, onClose, onCreate }) {
  const [name, setName] = useState(''); const [type, setType] = useState('dds')
  const [projectId, setProjectId] = useState(projects[0]?.id || '')
  const [periodFrom, setPeriodFrom] = useState(() => { const d = new Date(); d.setMonth(0, 1); return d.toISOString().slice(0, 10) })
  const [periodTo, setPeriodTo] = useState(() => { const d = new Date(); d.setMonth(11, 31); return d.toISOString().slice(0, 10) })
  const [saving, setSaving] = useState(false)
  const handleSubmit = async () => { if (!name.trim() || !projectId) return; setSaving(true); try { const r = await createBudgetDocument({ name, type, period_from: periodFrom, period_to: periodTo, project_id: projectId }); onCreate(r.data.data) } finally { setSaving(false) } }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="p-6 border-b border-gray-100"><h3 className="text-lg font-semibold text-gray-800">Новый бюджет</h3></div>
        <div className="p-6 space-y-4">
          <div><label className="block text-xs font-medium text-gray-600 mb-1">Название</label><input className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={name} onChange={e => setName(e.target.value)} placeholder="Бюджет ДДС 2026" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-medium text-gray-600 mb-1">Тип</label><select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={type} onChange={e => setType(e.target.value)}><option value="dds">ДДС</option><option value="bdr">БДР</option></select></div>
            <div><label className="block text-xs font-medium text-gray-600 mb-1">Проект</label><select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-medium text-gray-600 mb-1">Период с</label><input type="date" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={periodFrom} onChange={e => setPeriodFrom(e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-gray-600 mb-1">Период по</label><input type="date" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={periodTo} onChange={e => setPeriodTo(e.target.value)} /></div>
          </div>
        </div>
        <div className="p-6 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Отмена</button>
          <button onClick={handleSubmit} disabled={saving || !name.trim()} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50">{saving ? 'Создаю...' : 'Создать'}</button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
export default function BudgetPage() {
  const navigate = useNavigate()
  const [documents, setDocuments] = useState([]); const [selectedDocId, setSelectedDocId] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false); const [projects, setProjects] = useState([])
  const [report, setReport] = useState(null); const [loading, setLoading] = useState(false)
  const [byCash, setByCash] = useState(false); const [showDelta, setShowDelta] = useState(false)
  const [expanded, setExpanded] = useState(new Set())

  // Drawer state
  const [drawer, setDrawer] = useState(null) // { articleId, articleName, periodDate, periodLabel, details }

  useEffect(() => { api.get('/me').catch(() => navigate('/login')); api.get('/projects').then(r => setProjects(r.data.data || r.data)); loadDocuments() }, [])
  const loadDocuments = async () => { const r = await getBudgetDocuments(); const d = r.data.data; setDocuments(d); if (d.length > 0 && !selectedDocId) setSelectedDocId(d[0].id) }
  useEffect(() => { if (selectedDocId) loadReport() }, [selectedDocId, byCash])

  const loadReport = async (keepState = false) => {
    if (!keepState) setLoading(true)
    try {
      const r = await getBudgetReport(selectedDocId, { by_cash: byCash ? 1 : 0 })
      setReport(r.data)
      // Раскрывать корневые узлы только при первой загрузке / смене документа
      if (!keepState) {
        const rootIds = new Set()
        const arts = r.data.articles
        if (Array.isArray(arts) && arts[0]?.id != null) arts.forEach(a => rootIds.add(a.id))
        else if (arts) arts.forEach(g => g.items?.forEach(a => rootIds.add(a.id)))
        setExpanded(rootIds)
      }
      // Обновить drawer если открыт
      if (drawer) {
        const key = `${drawer.articleId}:0:${drawer.periodDate}`
        setDrawer(prev => prev ? { ...prev, details: r.data.plan_details?.[key] || [] } : null)
      }
    } finally { if (!keepState) setLoading(false) }
  }

  const openDrawer = (articleId, articleName, periodDate) => {
    const key = `${articleId}:0:${periodDate}`
    setDrawer({ articleId, articleName, periodDate, periodLabel: monthLabel(periodDate), details: planDetails[key] || [] })
  }

  const saveOpeningBalance = useCallback(async (amount) => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount, is_manual: true })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: amount, is_manual: true } } } : prev)
  }, [selectedDocId])

  const toggleExpand = (id) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const selectedDoc = documents.find(d => d.id === selectedDocId)
  const periodDates = report?.period_dates || []; const plan = report?.plan || {}; const fact = report?.fact || {}
  const planDetails = report?.plan_details || {}; const openBal = report?.opening_balances || {}; const cashItems = report?.cash_items || []
  const colsPerMonth = showDelta ? 3 : 2

  const { flatArticles, descendantLeafMap } = useMemo(() => {
    if (!report?.articles) return { flatArticles: [], descendantLeafMap: {} }
    const arts = report.articles
    if (Array.isArray(arts) && arts[0]?.id != null) return { flatArticles: flattenArticles(arts), descendantLeafMap: buildDescendantLeafMap(arts) }
    const allItems = [], allFlat = []
    for (const g of arts) { allFlat.push({ id: `group_${g.group}`, name: g.label, depth: 0, isGroup: true }); allFlat.push(...flattenArticles(g.items || [], 1)); allItems.push(...(g.items || [])) }
    return { flatArticles: allFlat, descendantLeafMap: buildDescendantLeafMap(allItems) }
  }, [report])

  const getArticleValue = useCallback((aid, pd, src) => {
    const lids = descendantLeafMap[aid]; const ids = (lids?.size > 0) ? lids : new Set([aid])
    let t = 0; const sfx = ':' + pd; for (const l of ids) { const p = l + ':'; for (const [k, v] of Object.entries(src)) if (k.startsWith(p) && k.endsWith(sfx)) t += v }; return t
  }, [descendantLeafMap])

  const calcMonthTotal = useCallback((pd, src) => { let t = 0; for (const [k, v] of Object.entries(src)) if (k.endsWith(':' + pd)) t += v; return t }, [])

  const autoOpening = useMemo(() => {
    if (!byCash) { const ob = openBal[0] || openBal['0']; return ob?.auto ?? 0 }
    let t = 0; for (const [, v] of Object.entries(openBal)) t += (v?.auto ?? 0); return t
  }, [openBal, byCash])
  const manualOpening = useMemo(() => { const ob = openBal[0] || openBal['0']; return ob?.is_manual ? (ob.manual ?? null) : null }, [openBal])
  const isManualOpening = manualOpening !== null
  const planOpeningAmount = isManualOpening ? manualOpening : autoOpening

  const resetOpeningBalance = useCallback(async () => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount: autoOpening, is_manual: false })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: null, is_manual: false } } } : prev)
  }, [selectedDocId, autoOpening])

  const factBalances = useMemo(() => { const r = []; let p = autoOpening; for (const pd of periodDates) { const o = p, m = calcMonthTotal(pd, fact); r.push({ opening: o, move: m, closing: o + m }); p = o + m }; return r }, [periodDates, fact, autoOpening, calcMonthTotal])
  const planBalances = useMemo(() => { const r = []; let p = planOpeningAmount; for (const pd of periodDates) { const o = p, m = calcMonthTotal(pd, plan); r.push({ opening: o, move: m, closing: o + m }); p = o + m }; return r }, [periodDates, plan, planOpeningAmount, calcMonthTotal])

  const cashOpenings = useMemo(() => { if (!byCash) return {}; const r = {}; for (const [c, ob] of Object.entries(openBal)) r[c] = ob?.auto ?? 0; return r }, [openBal, byCash])
  const cashBalances = useMemo(() => {
    if (!byCash || !cashItems.length) return {}; const r = {}
    for (const ci of cashItems) { const a = []; let p = cashOpenings[ci.id] ?? cashOpenings[String(ci.id)] ?? 0
      for (const pd of periodDates) { const o = p; let m = 0; for (const [k, v] of Object.entries(fact)) { if (k.split(':')[1] === String(ci.id) && k.endsWith(':' + pd)) m += v }; a.push({ opening: o, move: m, closing: o + m }); p = o + m }; r[ci.id] = a }; return r
  }, [byCash, cashItems, cashOpenings, periodDates, fact])

  const visibleArticles = useMemo(() => {
    const r = []; let skip = null
    for (const a of flatArticles) { if (skip !== null && a.depth > skip) continue; skip = null; r.push(a); if (a.hasChildren && !expanded.has(a.id)) skip = a.depth }; return r
  }, [flatArticles, expanded])

  const renderHeaderSub = (pd) => (
    <Fragment key={pd}>
      <th className="text-center px-1 py-1 text-[10px] text-blue-500 font-medium border-b border-l border-gray-200" style={{ width: 80 }}>План</th>
      <th className="text-center px-1 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-200" style={{ width: 80 }}>Факт</th>
      {showDelta && <th className="text-center px-1 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-200" style={{ width: 50 }}>Δ</th>}
    </Fragment>
  )

  return (
    <Layout>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white" value={selectedDocId || ''} onChange={e => setSelectedDocId(Number(e.target.value))}>
          {documents.length === 0 && <option value="">Нет документов</option>}
          {documents.map(d => <option key={d.id} value={d.id}>{d.name} ({d.type.toUpperCase()})</option>)}
        </select>
        {selectedDoc && <span className={`text-xs px-2 py-1 rounded-full ${selectedDoc.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{selectedDoc.status === 'approved' ? 'Утверждён' : 'Черновик'}</span>}
        {selectedDoc?.type === 'dds' && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-2">
            <button className={`px-3 py-1.5 text-xs font-medium ${!byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(false)}>Общая сумма</button>
            <button className={`px-3 py-1.5 text-xs font-medium ${byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(true)}>По кассам</button>
          </div>
        )}
        <button className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${showDelta ? 'bg-blue-900 text-white border-blue-900' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`} onClick={() => setShowDelta(v => !v)}>Δ Отклонение</button>
        <div className="ml-auto"><button onClick={() => setShowCreateModal(true)} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800">+ Новый бюджет</button></div>
      </div>

      {loading ? <div className="text-center py-20 text-gray-400">Загрузка отчёта...</div>
      : !report ? <div className="text-center py-20 text-gray-400">{documents.length === 0 ? 'Создайте первый бюджет' : 'Выберите документ'}</div>
      : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" style={{ minWidth: `${280 + periodDates.length * (showDelta ? 210 : 160)}px` }}>
              <thead>
                <tr className="bg-gray-50">
                  <th className="sticky left-0 z-10 bg-gray-50 text-left px-3 py-2 font-semibold text-gray-600 border-b border-gray-200" style={{ minWidth: 240 }}>Статья</th>
                  {periodDates.map(pd => <th key={pd} colSpan={colsPerMonth} className={`text-center px-1 py-2 font-medium border-b border-l border-gray-200 ${isCurrentMonth(pd) ? 'bg-blue-50 text-blue-800' : 'text-gray-600'}`}>{monthLabel(pd)}{isCurrentMonth(pd) && <span className="ml-1 text-[9px] text-blue-500">▸ тек.</span>}</th>)}
                </tr>
                <tr className="bg-gray-50/50"><th className="sticky left-0 z-10 bg-gray-50 border-b border-gray-200" />{periodDates.map(renderHeaderSub)}</tr>
              </thead>
              <tbody>
                {/* Остаток на начало */}
                {selectedDoc?.type === 'dds' && (<>
                  <tr className="bg-gray-50 font-semibold border-b border-gray-200">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">
                      <div className="flex items-center gap-2">01 Остаток на начало
                        {isManualOpening && <button onClick={resetOpeningBalance} className="text-[10px] font-normal text-amber-600 hover:text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded" title="Сбросить к факту">↻ сброс</button>}
                      </div>
                    </td>
                    {periodDates.map((pd, i) => { const fb = factBalances[i], pb = planBalances[i]; if (!fb || !pb) return <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>; return (<Fragment key={pd}>
                      {i === 0 ? <PlanCellSimple value={planOpeningAmount} onSave={saveOpeningBalance} disabled={selectedDoc.status === 'approved'} /> : <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.opening)}</td>}
                      <td className="text-right px-2 py-1.5 tabular-nums text-gray-700">{fmt(fb.opening)}</td>
                      {showDelta && <DeltaCell fact={fb.opening} plan={pb.opening} />}
                    </Fragment>) })}
                  </tr>
                  {byCash && cashItems.map(ci => <tr key={`co_${ci.id}`} className="border-b border-gray-50"><td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-500 text-[11px]" style={{ paddingLeft: 28 }}>└ {ci.name}</td>{periodDates.map((pd, i) => { const cb = cashBalances[ci.id]?.[i]; return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.opening)}</td><td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px]">{fmt(cb?.opening)}</td>{showDelta && <td />}</Fragment> })}</tr>)}
                </>)}

                {/* Строки статей */}
                {visibleArticles.map(article => {
                  if (article.isGroup) return <tr key={article.id} className="bg-gray-100 border-b border-gray-200"><td className="sticky left-0 z-10 bg-gray-100 px-3 py-2 font-semibold text-gray-700" colSpan={1 + periodDates.length * colsPerMonth}>{article.name}</td></tr>
                  const isParent = article.hasChildren
                  return (
                    <tr key={article.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${isParent ? 'bg-gray-50/50 font-medium' : ''}`}>
                      <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-gray-700 whitespace-nowrap" style={{ paddingLeft: 12 + article.depth * 20 }}>
                        <div className="flex items-center gap-1">
                          {isParent && <button onClick={() => toggleExpand(article.id)} className="text-gray-400 hover:text-gray-600 text-[10px] w-4">{expanded.has(article.id) ? '▼' : '▶'}</button>}
                          <span className={article.depth === 0 ? 'font-medium' : ''}>{article.depth > 0 && !isParent && <span className="text-gray-300 mr-1">└</span>}{article.name}</span>
                        </div>
                      </td>
                      {periodDates.map(pd => {
                        const factVal = getArticleValue(article.id, pd, fact)
                        const planVal = getArticleValue(article.id, pd, plan)
                        const future = isFutureMonth(pd)
                        const editable = !isParent && selectedDoc?.status !== 'approved'
                        const key = `${article.id}:0:${pd}`
                        const count = planDetails[key]?.length || 0
                        return (
                          <Fragment key={pd}>
                            {editable ? (
                              <PlanCell value={planVal} detailCount={count} disabled={false}
                                onClick={() => openDrawer(article.id, article.name, pd)} />
                            ) : (
                              <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(planVal)}</td>
                            )}
                            <td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : factVal > 0 ? 'text-gray-700' : factVal < 0 ? 'text-red-600' : 'text-gray-400'}`}>{future ? '—' : fmt(factVal)}</td>
                            {showDelta && <DeltaCell fact={future ? null : factVal} plan={planVal} />}
                          </Fragment>
                        )
                      })}
                    </tr>
                  )
                })}

                {/* Движение */}
                {selectedDoc?.type === 'dds' && (
                  <tr className="bg-gray-50 font-semibold border-t border-gray-200">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">02 Движение</td>
                    {periodDates.map((pd, i) => { const fb = factBalances[i], pb = planBalances[i]; if (!fb || !pb) return <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>; const future = isFutureMonth(pd)
                      return <Fragment key={pd}><td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.move)}</td><td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : fb.move >= 0 ? 'text-gray-700' : 'text-red-600'}`}>{future ? '—' : fmt(fb.move)}</td>{showDelta && <DeltaCell fact={future ? null : fb.move} plan={pb.move} />}</Fragment>
                    })}
                  </tr>
                )}

                {/* Остаток на конец */}
                {selectedDoc?.type === 'dds' && (<>
                  <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">03 Остаток на конец</td>
                    {periodDates.map((pd, i) => { const fb = factBalances[i], pb = planBalances[i]; if (!fb || !pb) return <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>; const future = isFutureMonth(pd)
                      return <Fragment key={pd}><td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.closing)}</td><td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : 'text-gray-700'}`}>{future ? '—' : fmt(fb.closing)}</td>{showDelta && <DeltaCell fact={future ? null : fb.closing} plan={pb.closing} />}</Fragment>
                    })}
                  </tr>
                  {byCash && cashItems.map(ci => <tr key={`cc_${ci.id}`} className="border-b border-gray-50"><td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-500 text-[11px]" style={{ paddingLeft: 28 }}>└ {ci.name}</td>{periodDates.map((pd, i) => { const cb = cashBalances[ci.id]?.[i]; return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.closing)}</td><td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px]">{fmt(cb?.closing)}</td>{showDelta && <td />}</Fragment> })}</tr>)}
                </>)}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-gray-100 flex gap-5 text-[11px] text-gray-400">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> План (клик для деталей)</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500" /> Факт</span>
            {showDelta && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Δ отклонение</span>}
          </div>
        </div>
      )}

      {/* Drawer */}
      {drawer && (
        <PlanDrawer
          articleName={drawer.articleName}
          periodLabel={drawer.periodLabel}
          details={drawer.details}
          articleId={drawer.articleId}
          periodDate={drawer.periodDate}
          docId={selectedDocId}
          onClose={() => setDrawer(null)}
          onUpdate={() => loadReport(true)}
        />
      )}

      {showCreateModal && <CreateDocModal projects={projects} onClose={() => setShowCreateModal(false)} onCreate={(doc) => { setDocuments(prev => [doc, ...prev]); setSelectedDocId(doc.id); setShowCreateModal(false) }} />}
    </Layout>
  )
}
