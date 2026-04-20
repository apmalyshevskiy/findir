import { Fragment, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  getBudgetDocuments, createBudgetDocument, updateBudgetDocument,
  getBudgetReport, getBudgetItems, createBudgetItem, deleteBudgetItem, upsertOpeningBalance,
} from '../api/budget'
import { createInfo, updateInfo } from '../api/info'
import Layout from '../components/Layout'
import BudgetDrawer from '../components/budget/BudgetDrawer'

// ── Утилиты ────────────────────────────────────────────────────────────────
const fmt = (v) => { if (v == null || v === '' || isNaN(v)) return ''; return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) }
const fmtDate = (d) => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('ru-RU') }
const monthLabel = (ds) => new Date(ds + 'T00:00:00').toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
const isCurrentMonth = (ds) => { const n = new Date(), d = new Date(ds + 'T00:00:00'); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() }
const isFutureMonth = (ds) => new Date(ds + 'T00:00:00') > new Date(new Date().getFullYear(), new Date().getMonth(), 1)
const endOfMonth = (ds) => { const d = new Date(ds + 'T00:00:00'); d.setMonth(d.getMonth() + 1); d.setDate(0); return d.toISOString().slice(0, 10) }

// ── Дерево ─────────────────────────────────────────────────────────────────
const flattenArticles = (articles, depth = 0) => {
  const r = []; for (const a of articles) { r.push({ ...a, depth, hasChildren: !!(a.children?.length) }); if (a.children) r.push(...flattenArticles(a.children, depth + 1)) }; return r
}
const buildDescendantLeafMap = (articles) => {
  const map = {}; const collect = (n) => { if (!n.children?.length) { map[n.id] = new Set([n.id]); return map[n.id] }; const s = new Set(); for (const c of n.children) for (const l of collect(c)) s.add(l); map[n.id] = s; return s }
  for (const a of articles) collect(a); return map
}

/** Все потомки включая промежуточные узлы (для drill-down) */
const buildDescendantAllMap = (articles) => {
  const map = {}
  const collect = (n) => {
    const s = new Set([n.id])
    if (n.children?.length) {
      for (const c of n.children) { for (const d of collect(c)) s.add(d) }
    }
    map[n.id] = s
    return s
  }
  for (const a of articles) collect(a)
  return map
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

// ── Ячейки ─────────────────────────────────────────────────────────────────
function PlanCell({ value, detailCount, disabled, onClick, isCopied, onCopy, onPaste, canPaste, onClearClipboard }) {
  const title = detailCount > 1 ? `${detailCount} строк плана` : detailCount === 1 ? '1 строка плана' : 'Нажмите для ввода'

  const handleClick = (e) => {
    if (disabled) return
    if (onClearClipboard) onClearClipboard()
    if (onClick) onClick()
  }

  const handleContext = (e) => {
    e.preventDefault()
    if (disabled) return
    if (canPaste && onPaste) {
      onPaste()
    } else if (onCopy) {
      onCopy()
    }
  }

  return (
    <td
      className={`px-2 py-1.5 text-right text-xs tabular-nums border-l border-gray-100 ${disabled ? 'text-blue-400' : 'text-blue-600 cursor-pointer hover:bg-blue-50'} ${isCopied ? 'outline outline-2 outline-dashed outline-blue-400 outline-offset-[-2px]' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContext}
      title={title}
    >
      {fmt(value)}
    </td>
  )
}

function FactCell({ value, future, onClick }) {
  if (future) return <td className="text-right px-2 py-1.5 tabular-nums text-gray-300">—</td>
  const cls = value > 0 ? 'text-gray-700' : value < 0 ? 'text-red-600' : 'text-gray-400'
  if (!value || !onClick) return <td className={`text-right px-2 py-1.5 tabular-nums ${cls}`}>{fmt(value)}</td>
  return <td className={`text-right px-2 py-1.5 tabular-nums ${cls} cursor-pointer hover:bg-gray-100`} onClick={onClick}><span className="hover:underline">{fmt(value)}</span></td>
}

function PlanCellSimple({ value, onSave, disabled }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(''); const ref = useRef(null)
  useEffect(() => { if (editing && ref.current) ref.current.focus() }, [editing])
  const commit = () => { setEditing(false); const n = parseFloat(text.replace(/\s/g, '').replace(',', '.')) || 0; if (n !== (value || 0)) onSave(n) }
  if (editing) return <td className="px-1 py-0.5"><input ref={ref} type="text" className="w-full text-right text-xs px-2 py-1 border border-blue-300 rounded bg-white text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-200" value={text} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }} /></td>
  return <td className={`px-2 py-1.5 text-right text-xs tabular-nums ${disabled ? 'text-blue-400' : 'text-blue-600 cursor-pointer hover:bg-blue-50 rounded'}`} onDoubleClick={() => { if (!disabled) { setText(value ? String(Math.round(value)) : ''); setEditing(true) } }}>{fmt(value)}</td>
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
  const [byCash, setByCash] = useState(false)
  const [viewMode, setViewMode] = useState('plan_fact') // 'plan' | 'fact' | 'plan_fact' | 'plan_fact_delta'
  const [factCutoffDate, setFactCutoffDate] = useState('') // '' = нет подстановки факта; '2026-03-01' = факт до этого месяца
  const [expanded, setExpanded] = useState(new Set())
  const [drawer, setDrawer] = useState(null)
  const [editDoc, setEditDoc] = useState(null) // { name, period_from, period_to }
  const [showSettingsPopup, setShowSettingsPopup] = useState(false) // попап настроек бюджета
  const [clipboard, setClipboard] = useState(null) // { articleId, section, periodDate, articleName }
  const [pasting, setPasting] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  // Inline-редактирование/создание статей справочника
  const [editArticle, setEditArticle] = useState(null)   // { id, name, parent_id, sort_order, type }
  const [addArticle, setAddArticle] = useState(null)      // { type, parent_id, groupKey }
  const [articleSaving, setArticleSaving] = useState(false)

  useEffect(() => { api.get('/me').catch(() => navigate('/login')); api.get('/projects').then(r => setProjects(r.data.data || r.data)); loadDocuments() }, [])
  const loadDocuments = async (withArchived) => {
    const params = (withArchived ?? showArchived) ? { show_archived: 1 } : {}
    const r = await getBudgetDocuments(params)
    const d = r.data.data; setDocuments(d)
    if (d.length > 0 && !selectedDocId) setSelectedDocId(d[0].id)
  }
  useEffect(() => { loadDocuments() }, [showArchived])
  useEffect(() => { if (selectedDocId) loadReport() }, [selectedDocId, byCash, factCutoffDate])

  const loadReport = async (keepState = false) => {
    if (!keepState) setLoading(true)
    try {
      const params = { by_cash: byCash ? 1 : 0 }
      if (factCutoffDate) params.display_from = factCutoffDate
      const r = await getBudgetReport(selectedDocId, params)
      setReport(r.data)
      if (!keepState) {
        const rootIds = new Set()
        const arts = r.data.articles
        if (Array.isArray(arts) && arts[0]?.id != null) arts.forEach(a => rootIds.add(a.id))
        else if (arts) arts.forEach(g => g.items?.forEach(a => rootIds.add(a.id)))
        setExpanded(rootIds)
      }
    } finally { if (!keepState) setLoading(false) }
  }

  // ── Открытие drawer (универсальный) ──────────────────────────────────────
  const openDrawer = (articleId, articleName, periodDate, initialTab = 'plan', section = null) => {
    setDrawer({ mode: initialTab, articleId, articleName, periodDate, periodLabel: monthLabel(periodDate), section })
  }

  // ── Копирование / вставка ячейки плана ─────────────────────────────────
  const handleCopyCell = (articleId, articleName, periodDate, section) => {
    setClipboard({ articleId, section, periodDate, articleName })
  }

  const handlePasteCell = async (targetArticleId, targetPeriodDate, targetSection) => {
    if (!clipboard) return
    // Вставляем только если та же статья (и section)
    if (clipboard.articleId !== targetArticleId || clipboard.section !== targetSection) return
    setPasting(true)
    try {
      // 1. Загружаем строки источника
      const srcIds = descendantAllMap[clipboard.articleId]
      const ids = srcIds && srcIds.size > 0 ? [...srcIds] : [clipboard.articleId]
      const res = await getBudgetItems({
        budget_document_id: selectedDocId,
        article_ids: ids.join(','),
        period_date: clipboard.periodDate,
        ...(clipboard.section ? { section: clipboard.section } : {}),
      })
      const srcRows = res.data.data || []
      if (srcRows.length === 0) { setPasting(false); return }

      // 2. Очищаем целевой месяц (та же статья + потомки)
      const existing = await getBudgetItems({
        budget_document_id: selectedDocId,
        article_ids: ids.join(','),
        period_date: targetPeriodDate,
        ...(targetSection ? { section: targetSection } : {}),
      })
      for (const row of (existing.data.data || [])) {
        await deleteBudgetItem(row.id)
      }

      // 3. Создаём копии в целевом месяце
      for (const row of srcRows) {
        await createBudgetItem({
          budget_document_id: selectedDocId,
          article_id: row.article_id,
          section: targetSection || null,
          period_date: targetPeriodDate,
          content: row.content || null,
          amount: row.amount,
        })
      }
      loadReport(true)
    } catch (err) {
      console.error('Ошибка вставки:', err)
    } finally {
      setPasting(false)
    }
  }

  const saveOpeningBalance = useCallback(async (amount) => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount, is_manual: true })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: amount, is_manual: true } } } : prev)
  }, [selectedDocId])

  const toggleExpand = (id) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const saveDocSettings = async () => {
    if (!editDoc || !selectedDocId) return
    await updateBudgetDocument(selectedDocId, editDoc)
    setDocuments(prev => prev.map(d => d.id === selectedDocId ? { ...d, ...editDoc } : d))
    setEditDoc(null)
    loadReport()
  }

  const changeStatus = async (newStatus) => {
    if (!selectedDocId) return
    await updateBudgetDocument(selectedDocId, { status: newStatus })
    if (newStatus === 'archived') {
      setDocuments(prev => {
        const filtered = prev.filter(d => d.id !== selectedDocId)
        if (filtered.length > 0) setSelectedDocId(filtered[0].id)
        else { setSelectedDocId(null); setReport(null) }
        return showArchived ? prev.map(d => d.id === selectedDocId ? { ...d, status: newStatus } : d) : filtered
      })
    } else {
      setDocuments(prev => prev.map(d => d.id === selectedDocId ? { ...d, status: newStatus } : d))
    }
  }

  // ── Inline-редактирование статей справочника ──────────────────────────────
  const infoTypeFromSection = (section) => {
    if (section === 'revenue' || section === 'cost') return 'revenue'
    if (section === 'expenses') return 'expenses'
    return 'flow' // ДДС
  }

  const openEditArticle = (article) => {
    const type = infoTypeFromSection(article.section || article.groupKey)
    setEditArticle({ id: article.id, name: article.name, parent_id: article.parent_id || '', sort_order: article.sort_order ?? 0, type, section: article.section || article.groupKey })
    setAddArticle(null)
  }

  const openAddArticle = (infoType, groupKey = null) => {
    setAddArticle({ type: infoType, parent_id: '', name: '', sort_order: 0, groupKey })
    setEditArticle(null)
  }

  const saveArticle = async () => {
    if (!editArticle || !editArticle.name.trim()) return
    setArticleSaving(true)
    try {
      await updateInfo(editArticle.id, {
        name: editArticle.name.trim(),
        type: editArticle.type,
        parent_id: editArticle.parent_id || null,
        sort_order: editArticle.sort_order || 0,
      })
      setEditArticle(null)
      loadReport(true)
    } catch (err) { console.error('Ошибка сохранения статьи:', err) }
    finally { setArticleSaving(false) }
  }

  const createArticle = async () => {
    if (!addArticle || !addArticle.name.trim()) return
    setArticleSaving(true)
    try {
      await createInfo({
        name: addArticle.name.trim(),
        type: addArticle.type,
        parent_id: addArticle.parent_id || null,
        sort_order: addArticle.sort_order || 0,
      })
      setAddArticle(null)
      loadReport(true)
    } catch (err) { console.error('Ошибка создания статьи:', err) }
    finally { setArticleSaving(false) }
  }

  // Все статьи текущей группы (для select родителя)
  const getGroupArticleOptions = useCallback((groupKey) => {
    if (!report?.articles) return []
    const arts = report.articles
    if (Array.isArray(arts) && arts[0]?.group) {
      const g = arts.find(a => a.group === groupKey)
      if (!g) return []
      const flat = []; const walk = (items, depth = 0) => { for (const a of items) { flat.push({ id: a.id, name: a.name, depth }); if (a.children) walk(a.children, depth + 1) } }
      walk(g.items || []); return flat
    }
    // ДДС — все статьи
    const flat = []; const walk = (items, depth = 0) => { for (const a of items) { flat.push({ id: a.id, name: a.name, depth }); if (a.children) walk(a.children, depth + 1) } }
    if (Array.isArray(arts)) walk(arts); return flat
  }, [report])

  const selectedDoc = documents.find(d => d.id === selectedDocId)
  const periodDates = report?.period_dates || []; const plan = report?.plan || {}; const fact = report?.fact || {}
  const planDetails = report?.plan_details || {}; const openBal = report?.opening_balances || {}; const cashItems = report?.cash_items || []

  // ── Режимы отображения ─────────────────────────────────────────────────
  const showPlan  = viewMode === 'plan' || viewMode === 'plan_fact' || viewMode === 'plan_fact_delta'
  const showFact  = viewMode === 'fact' || viewMode === 'plan_fact' || viewMode === 'plan_fact_delta'
  const showDelta = viewMode === 'plan_fact_delta'
  const isPlanOnly = viewMode === 'plan'
  const isFactOnly = viewMode === 'fact'
  const colsPerMonth = (isPlanOnly || isFactOnly) ? 1 : showDelta ? 3 : 2

  // Месяцы ДО начала бюджета (расширение влево через «Показать с:») = фактические.
  // Работает во всех режимах. budget_period_from приходит с бэка.
  const budgetPeriodFrom = report?.budget_period_from || selectedDoc?.period_from?.slice(0, 10) || ''
  const isFactMonth = (pd) => budgetPeriodFrom && pd < budgetPeriodFrom

  const { flatArticles, descendantLeafMap, descendantAllMap } = useMemo(() => {
    if (!report?.articles) return { flatArticles: [], descendantLeafMap: {}, descendantAllMap: {} }
    const arts = report.articles
    if (Array.isArray(arts) && arts[0]?.id != null) return { flatArticles: flattenArticles(arts), descendantLeafMap: buildDescendantLeafMap(arts), descendantAllMap: buildDescendantAllMap(arts) }
    const allItems = [], allFlat = []
    for (const g of arts) { allFlat.push({ id: `group_${g.group}`, name: g.label, depth: 0, isGroup: true, groupKey: g.group }); allFlat.push(...flattenArticles(g.items || [], 1).map(a => ({ ...a, section: g.group }))); allItems.push(...(g.items || [])) }
    return { flatArticles: allFlat, descendantLeafMap: buildDescendantLeafMap(allItems), descendantAllMap: buildDescendantAllMap(allItems) }
  }, [report])

  const getArticleValue = useCallback((aid, pd, src, section = null) => {
    const allIds = descendantAllMap[aid]; const ids = (allIds?.size > 0) ? allIds : new Set([aid])
    let t = 0; const sfx = ':' + pd
    if (section) {
      for (const l of ids) { const p = section + ':' + l + ':'; for (const [k, v] of Object.entries(src)) if (k.startsWith(p) && k.endsWith(sfx)) t += v }
    } else {
      for (const l of ids) { const p = l + ':'; for (const [k, v] of Object.entries(src)) if (k.startsWith(p) && k.endsWith(sfx)) t += v }
    }
    return t
  }, [descendantAllMap])
  const calcMonthTotal = useCallback((pd, src) => { let t = 0; for (const [k, v] of Object.entries(src)) if (k.endsWith(':' + pd)) t += v; return t }, [])

  // ── БДР: суммы по группам для строк прибыли ──────────────────────────────
  const bdrGroupTotals = useMemo(() => {
    if (selectedDoc?.type !== 'bdr' || !report?.articles) return {}
    const arts = report.articles
    if (!Array.isArray(arts) || !arts[0]?.group) return {}
    const result = {}
    for (const g of arts) {
      result[g.group] = {}
      const allNodeIds = new Set()
      const collectAll = (items) => { for (const it of items) { allNodeIds.add(it.id); if (it.children?.length) collectAll(it.children) } }
      collectAll(g.items || [])
      for (const pd of periodDates) {
        let f = 0, p = 0
        for (const nid of allNodeIds) {
          const sfx = ':' + pd; const pfx = g.group + ':' + nid + ':'
          for (const [k, v] of Object.entries(fact)) if (k.startsWith(pfx) && k.endsWith(sfx)) f += v
          for (const [k, v] of Object.entries(plan)) if (k.startsWith(pfx) && k.endsWith(sfx)) p += v
        }
        result[g.group][pd] = { fact: f, plan: p }
      }
    }
    return result
  }, [selectedDoc, report, periodDates, fact, plan])

  // autoOpening: фактический остаток на начало бюджета.
  // Если общий (cash_id=null) = 0, берём сумму по всем кассам.
  const autoOpening = useMemo(() => {
    const ob0 = openBal[0] || openBal['0']
    const generalAuto = ob0?.auto ?? 0
    if (generalAuto !== 0) return generalAuto
    // fallback: сумма по всем кассам
    let t = 0; for (const [, v] of Object.entries(openBal)) t += (v?.auto ?? 0)
    return t
  }, [openBal])
  const manualOpening = useMemo(() => { const ob = openBal[0] || openBal['0']; return ob?.is_manual ? (ob.manual ?? null) : null }, [openBal])
  const isManualOpening = manualOpening !== null; const planOpeningAmount = isManualOpening ? manualOpening : autoOpening

  // В режимах план / план+факт: плановые балансы стартуют от фактического остатка
  const effectivePlanOpening = (isPlanOnly || viewMode === 'plan_fact' || viewMode === 'plan_fact_delta') ? autoOpening : planOpeningAmount

  const resetOpeningBalance = useCallback(async () => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount: autoOpening, is_manual: false })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: null, is_manual: false } } } : prev)
  }, [selectedDocId, autoOpening])

  const factBalances = useMemo(() => { const r = []; let p = autoOpening; for (const pd of periodDates) { const o = p, m = calcMonthTotal(pd, fact); r.push({ opening: o, move: m, closing: o + m }); p = o + m }; return r }, [periodDates, fact, autoOpening, calcMonthTotal])
  // planBalances: для фактических месяцев (до budgetPeriodFrom) берём fact-движение,
  // чтобы остаток на начало первого планового месяца = факт на конец последнего фактического
  const planBalances = useMemo(() => {
    const r = []; let p = effectivePlanOpening
    for (const pd of periodDates) {
      const o = p
      const isFact = budgetPeriodFrom && pd < budgetPeriodFrom
      const m = isFact ? calcMonthTotal(pd, fact) : calcMonthTotal(pd, plan)
      r.push({ opening: o, move: m, closing: o + m }); p = o + m
    }
    return r
  }, [periodDates, plan, fact, effectivePlanOpening, budgetPeriodFrom, calcMonthTotal])
  const cashOpenings = useMemo(() => { if (!byCash) return {}; const r = {}; for (const [c, ob] of Object.entries(openBal)) r[c] = ob?.auto ?? 0; return r }, [openBal, byCash])
  const cashBalances = useMemo(() => { if (!byCash || !cashItems.length) return {}; const r = {}; for (const ci of cashItems) { const a = []; let p = cashOpenings[ci.id] ?? cashOpenings[String(ci.id)] ?? 0; for (const pd of periodDates) { const o = p; let m = 0; for (const [k, v] of Object.entries(fact)) if (k.split(':')[1] === String(ci.id) && k.endsWith(':' + pd)) m += v; a.push({ opening: o, move: m, closing: o + m }); p = o + m }; r[ci.id] = a }; return r }, [byCash, cashItems, cashOpenings, periodDates, fact])

  const visibleArticles = useMemo(() => { const r = []; let skip = null; for (const a of flatArticles) { if (skip !== null && a.depth > skip) continue; skip = null; r.push(a); if (a.hasChildren && !expanded.has(a.id)) skip = a.depth }; return r }, [flatArticles, expanded])

  const renderHeaderSub = (pd) => {
    const fm = isFactMonth(pd)
    if (isPlanOnly) return <Fragment key={pd}><th className={`text-center px-1 py-1 text-[10px] font-medium border-b border-l border-gray-200 ${fm ? 'text-gray-400' : 'text-blue-500'}`} style={{ width: 80 }}>{fm ? 'Факт' : 'План'}</th></Fragment>
    if (isFactOnly) return <Fragment key={pd}><th className="text-center px-1 py-1 text-[10px] text-gray-500 font-medium border-b border-l border-gray-200" style={{ width: 80 }}>Факт</th></Fragment>
    return (
      <Fragment key={pd}>
        <th className="text-center px-1 py-1 text-[10px] text-blue-500 font-medium border-b border-l border-gray-200" style={{ width: 80 }}>План</th>
        <th className="text-center px-1 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-200" style={{ width: 80 }}>Факт</th>
        {showDelta && <th className="text-center px-1 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-200" style={{ width: 50 }}>Δ</th>}
      </Fragment>
    )
  }

  // ── Строка-итог БДР (прибыль) ─────────────────────────────────────────────
  const renderProfitRow = (label, calcFn, borderCls = 'border-t border-gray-200') => (
    <tr className={`bg-gray-50 font-semibold ${borderCls}`}>
      <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">{label}</td>
      {periodDates.map(pd => {
        const { factVal, planVal } = calcFn(pd)
        const future = isFutureMonth(pd)
        const fm = isFactMonth(pd)
        if (isPlanOnly) {
          const val = fm ? factVal : planVal
          return <Fragment key={pd}><td className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${fm ? 'text-gray-400 italic' : 'text-blue-600'}`}>{fmt(val)}</td></Fragment>
        }
        if (isFactOnly) {
          return <Fragment key={pd}><td className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${future ? 'text-gray-300' : factVal >= 0 ? 'text-gray-700' : 'text-red-600'}`}>{future ? '—' : fmt(factVal)}</td></Fragment>
        }
        return (
          <Fragment key={pd}>
            <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(planVal)}</td>
            <td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : factVal >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{future ? '—' : fmt(factVal)}</td>
            {showDelta && <DeltaCell fact={future ? null : factVal} plan={planVal} />}
          </Fragment>
        )
      })}
    </tr>
  )

  return (
    <Layout>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Селект бюджета — с цветовой подсветкой статуса */}
        <select
          className={`px-3 py-2 border rounded-lg text-sm ${
            selectedDoc?.status === 'approved' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' :
            selectedDoc?.status === 'archived' ? 'border-gray-300 bg-gray-100 text-gray-500' :
            'border-amber-300 bg-amber-50 text-amber-800'
          }`}
          value={selectedDocId || ''}
          onChange={e => setSelectedDocId(Number(e.target.value))}
        >
          {documents.length === 0 && <option value="">Нет документов</option>}
          {documents.map(d => (
            <option key={d.id} value={d.id}>
              {d.status === 'approved' ? '✓ ' : d.status === 'archived' ? '⊘ ' : '○ '}{d.name} ({d.type.toUpperCase()})
            </option>
          ))}
        </select>

        {/* Кнопка ⚙ — попап настроек бюджета */}
        {selectedDoc && (
          <div className="relative">
            <button
              onClick={() => setShowSettingsPopup(v => !v)}
              className={`text-gray-400 hover:text-gray-600 text-sm px-1.5 py-1 rounded ${showSettingsPopup ? 'bg-gray-100 text-gray-600' : ''}`}
              title="Настройки бюджета"
            >⚙</button>
            {showSettingsPopup && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowSettingsPopup(false)} />
                <div className="absolute left-0 top-full mt-1 z-40 bg-white rounded-xl shadow-xl border border-gray-200 w-80 p-4 space-y-3">
                  {/* Статус */}
                  <div>
                    <div className="text-[10px] uppercase text-gray-400 font-medium mb-1.5">Статус</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        selectedDoc.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                        selectedDoc.status === 'archived' ? 'bg-gray-200 text-gray-500' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {selectedDoc.status === 'approved' ? 'Утверждён' : selectedDoc.status === 'archived' ? 'Архив' : 'Черновик'}
                      </span>
                      {selectedDoc.status === 'draft' && (
                        <button onClick={() => { changeStatus('approved'); setShowSettingsPopup(false) }} className="text-[11px] text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 px-2 py-0.5 rounded">Утвердить</button>
                      )}
                      {selectedDoc.status === 'approved' && (
                        <>
                          <button onClick={() => { changeStatus('draft'); setShowSettingsPopup(false) }} className="text-[11px] text-amber-600 hover:text-amber-800 hover:bg-amber-50 px-2 py-0.5 rounded">В черновик</button>
                          <button onClick={() => { changeStatus('archived'); setShowSettingsPopup(false) }} className="text-[11px] text-gray-400 hover:text-gray-600 hover:bg-gray-100 px-2 py-0.5 rounded">В архив</button>
                        </>
                      )}
                      {selectedDoc.status === 'archived' && (
                        <button onClick={() => { changeStatus('draft'); setShowSettingsPopup(false) }} className="text-[11px] text-amber-600 hover:text-amber-800 hover:bg-amber-50 px-2 py-0.5 rounded">Восстановить</button>
                      )}
                    </div>
                  </div>
                  {/* Редактирование */}
                  <div className="border-t border-gray-100 pt-3 space-y-2">
                    <div className="text-[10px] uppercase text-gray-400 font-medium mb-1">Параметры</div>
                    <div>
                      <label className="block text-[11px] text-gray-500 mb-0.5">Название</label>
                      <input className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm bg-white"
                        value={editDoc?.name ?? selectedDoc.name}
                        onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), name: e.target.value }))}
                        onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-gray-500 mb-0.5">Период с</label>
                        <input type="date" className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
                          value={editDoc?.period_from ?? selectedDoc.period_from?.slice(0,10)}
                          onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), period_from: e.target.value }))}
                          onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-gray-500 mb-0.5">Период по</label>
                        <input type="date" className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
                          value={editDoc?.period_to ?? selectedDoc.period_to?.slice(0,10)}
                          onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), period_to: e.target.value }))}
                          onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                        />
                      </div>
                    </div>
                    {editDoc && (
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => { saveDocSettings(); setShowSettingsPopup(false) }} className="px-3 py-1.5 text-xs bg-blue-900 text-white rounded-lg hover:bg-blue-800">Сохранить</button>
                        <button onClick={() => { setEditDoc(null) }} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg">Отмена</button>
                      </div>
                    )}
                  </div>
                  {/* Архив */}
                  <div className="border-t border-gray-100 pt-3">
                    <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                      <input type="checkbox" checked={showArchived} onChange={e => { setShowArchived(e.target.checked); setShowSettingsPopup(false) }} className="rounded border-gray-300" />
                      Показывать архивные бюджеты
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Режимы отображения */}
        {selectedDoc?.type === 'dds' && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-2">
            <button className={`px-3 py-1.5 text-xs font-medium ${!byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(false)}>Общая сумма</button>
            <button className={`px-3 py-1.5 text-xs font-medium ${byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(true)}>По кассам</button>
          </div>
        )}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-1">
          {[{k:'plan',l:'План'},{k:'fact',l:'Факт'},{k:'plan_fact',l:'П+Ф'},{k:'plan_fact_delta',l:'П+Ф+Δ'}].map(m => (
            <button key={m.k} className={`px-2.5 py-1.5 text-[11px] font-medium ${viewMode === m.k ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setViewMode(m.k)}>{m.l}</button>
          ))}
        </div>
        {selectedDoc && (
          <div className="flex items-center gap-1.5 ml-2">
            <span className="text-[11px] text-gray-400">Показать с:</span>
            <input type="month" className="px-1.5 py-1 border border-gray-200 rounded text-[11px] bg-white w-[130px]"
              value={factCutoffDate ? factCutoffDate.slice(0, 7) : ''}
              placeholder={selectedDoc?.period_from?.slice(0, 7) || ''}
              onChange={e => { const v = e.target.value; setFactCutoffDate(v ? v + '-01' : '') }} />
            {factCutoffDate && <button className="text-[10px] text-gray-400 hover:text-gray-600 ml-0.5" onClick={() => setFactCutoffDate('')} title="Сбросить к началу бюджета">✕</button>}
          </div>
        )}
        <div className="ml-auto">
          <button onClick={() => setShowCreateModal(true)} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800">+ Новый бюджет</button>
        </div>
      </div>

      {/* Период бюджета */}
      {selectedDoc && (
        <div className="text-[11px] text-gray-400 mb-3 -mt-2">
          {new Date(selectedDoc.period_from).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })} – {new Date(selectedDoc.period_to).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}
        </div>
      )}

      {loading ? <div className="text-center py-20 text-gray-400">Загрузка отчёта...</div>
      : !report ? <div className="text-center py-20 text-gray-400">{documents.length === 0 ? 'Создайте первый бюджет' : 'Выберите документ'}</div>
      : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {/* Индикатор буфера обмена */}
          {(clipboard || pasting) && (
            <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
              <span className="text-[11px] text-blue-600">
                {pasting
                  ? 'Вставка...'
                  : <>Скопировано: <span className="font-medium">{clipboard.articleName}</span> / {monthLabel(clipboard.periodDate)} — ПКМ на ячейку плана для вставки</>
                }
              </span>
              {!pasting && (
                <button onClick={() => setClipboard(null)} className="text-[10px] text-blue-400 hover:text-blue-600">✕ Очистить</button>
              )}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" style={{ minWidth: `${280 + periodDates.length * ((isPlanOnly || isFactOnly) ? 85 : showDelta ? 210 : 160)}px` }}>
              <thead>
                <tr className="bg-gray-50">
                  <th className="sticky left-0 z-10 bg-gray-50 text-left px-3 py-2 font-semibold text-gray-600 border-b border-gray-200" style={{ minWidth: 240 }}>
                    <div className="flex items-center gap-2">
                      Статья
                      {selectedDoc?.type === 'dds' && selectedDoc?.status === 'draft' && (
                        <button onClick={() => openAddArticle('flow', '_dds')} className="text-[10px] font-normal text-gray-400 hover:text-blue-600 hover:bg-blue-50 px-1.5 py-0.5 rounded">+ статья</button>
                      )}
                    </div>
                  </th>
                  {periodDates.map(pd => { const fm = isFactMonth(pd); return <th key={pd} colSpan={colsPerMonth} className={`text-center px-1 py-2 font-medium border-b border-l border-gray-200 ${fm ? 'bg-gray-50 text-gray-400' : isCurrentMonth(pd) ? 'bg-blue-50 text-blue-800' : 'text-gray-600'}`}>{monthLabel(pd)}{isCurrentMonth(pd) && !fm && <span className="ml-1 text-[9px] text-blue-500">▸ тек.</span>}{fm && <span className="ml-1 text-[9px] text-gray-400">● факт</span>}</th> })}
                </tr>
                <tr className="bg-gray-50/50"><th className="sticky left-0 z-10 bg-gray-50 border-b border-gray-200" />{periodDates.map(renderHeaderSub)}</tr>
              </thead>
              <tbody>
                {/* ДДС: Остаток на начало */}
                {selectedDoc?.type === 'dds' && (<>
                  <tr className="bg-gray-50 font-semibold border-b border-gray-200">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">
                      <div className="flex items-center gap-2">01 Остаток на начало
                        {isManualOpening && <button onClick={resetOpeningBalance} className="text-[10px] font-normal text-amber-600 hover:text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded" title="Сбросить к факту">↻ сброс</button>}
                      </div>
                    </td>
                    {periodDates.map((pd, i) => { const fb = factBalances[i], pb = planBalances[i]; if (!fb || !pb) return <Fragment key={pd}>{Array(colsPerMonth).fill(null).map((_, j) => <td key={j} />)}</Fragment>
                      if (isPlanOnly) {
                        // Режим «Только план»: первый месяц = фактический остаток, read-only
                        return <Fragment key={pd}><td className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${i === 0 ? 'text-gray-500 italic' : 'text-blue-600'}`} title={i === 0 ? 'Фактический остаток' : undefined}>{fmt(pb.opening)}</td></Fragment>
                      }
                      if (isFactOnly) {
                        return <Fragment key={pd}><td className="text-right px-2 py-1.5 tabular-nums text-gray-700 border-l border-gray-100">{fmt(fb.opening)}</td></Fragment>
                      }
                      // План+Факт / +Δ: первый месяц колонка «План» = факт (read-only)
                      return (<Fragment key={pd}>
                      {i === 0
                        ? <td className="text-right px-2 py-1.5 tabular-nums text-gray-500 italic border-l border-gray-100" title="Фактический остаток">{fmt(effectivePlanOpening)}</td>
                        : <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.opening)}</td>
                      }
                      <td className="text-right px-2 py-1.5 tabular-nums text-gray-700">{fmt(fb.opening)}</td>
                      {showDelta && <DeltaCell fact={fb.opening} plan={pb.opening} />}
                    </Fragment>) })}
                  </tr>
                  {byCash && cashItems.map(ci => <tr key={`co_${ci.id}`} className="border-b border-gray-50"><td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-500 text-[11px]" style={{ paddingLeft: 28 }}>└ {ci.name}</td>{periodDates.map((pd, i) => { const cb = cashBalances[ci.id]?.[i]
                    if (isPlanOnly) return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.opening)}</td></Fragment>
                    if (isFactOnly) return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px] border-l border-gray-100">{fmt(cb?.opening)}</td></Fragment>
                    return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.opening)}</td><td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px]">{fmt(cb?.opening)}</td>{showDelta && <td />}</Fragment> })}</tr>)}
                </>)}

                {/* ДДС: inline-форма создания статьи */}
                {addArticle?.groupKey === '_dds' && (
                  <tr className="border-b border-blue-100 bg-blue-50/40">
                    <td colSpan={1 + periodDates.length * colsPerMonth} className="px-4 py-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <input className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-44" placeholder="Название новой статьи"
                          value={addArticle.name} onChange={e => setAddArticle(prev => ({ ...prev, name: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') createArticle(); if (e.key === 'Escape') setAddArticle(null) }}
                          autoFocus />
                        <select className="px-2 py-1 border border-gray-200 rounded text-xs bg-white text-gray-600 w-40"
                          value={addArticle.parent_id} onChange={e => setAddArticle(prev => ({ ...prev, parent_id: e.target.value }))}>
                          <option value="">— Без родителя</option>
                          {getGroupArticleOptions(null).map(o => (
                            <option key={o.id} value={o.id}>{'\u00A0'.repeat(o.depth * 2)}{o.depth > 0 ? '└ ' : ''}{o.name}</option>
                          ))}
                        </select>
                        <input className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-16 text-center" type="number" placeholder="Порядок"
                          value={addArticle.sort_order} onChange={e => setAddArticle(prev => ({ ...prev, sort_order: parseInt(e.target.value) || 0 }))} />
                        <button onClick={createArticle} disabled={!addArticle.name.trim() || articleSaving}
                          className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">{articleSaving ? '...' : 'Создать'}</button>
                        <button onClick={() => setAddArticle(null)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700">Отмена</button>
                      </div>
                    </td>
                  </tr>
                )}

                {/* Строки статей */}
                {visibleArticles.map((article, artIdx) => {
                  if (article.isGroup) {
                    const totals = bdrGroupTotals[article.groupKey]
                    return (
                      <Fragment key={article.id}>
                        {/* Валовая прибыль перед группой расходов */}
                        {selectedDoc?.type === 'bdr' && article.groupKey === 'expenses' && bdrGroupTotals.revenue && bdrGroupTotals.cost && (
                          renderProfitRow('Валовая прибыль', (pd) => ({
                            factVal: (bdrGroupTotals.revenue[pd]?.fact || 0) + (bdrGroupTotals.cost[pd]?.fact || 0),
                            planVal: (bdrGroupTotals.revenue[pd]?.plan || 0) + (bdrGroupTotals.cost[pd]?.plan || 0),
                          }), 'border-t-2 border-gray-300')
                        )}
                        {/* Заголовок группы с итогами */}
                        <tr className="bg-gray-100 border-b border-gray-200">
                          <td className="sticky left-0 z-10 bg-gray-100 px-3 py-2 font-semibold text-gray-700">
                            <div className="flex items-center gap-2">
                              {article.name}
                              <button
                                onClick={() => openAddArticle(article.groupKey === 'expenses' ? 'expenses' : article.groupKey === 'cost' ? 'revenue' : 'revenue', article.groupKey)}
                                className="text-[10px] font-normal text-gray-400 hover:text-blue-600 hover:bg-blue-50 px-1.5 py-0.5 rounded"
                                title="Добавить статью"
                              >+ статья</button>
                            </div>
                          </td>
                          {selectedDoc?.type === 'bdr' && totals ? periodDates.map(pd => {
                            const g = totals[pd] || { fact: 0, plan: 0 }
                            const future = isFutureMonth(pd)
                            const fm = isFactMonth(pd)
                            if (isPlanOnly) {
                              const val = fm ? g.fact : g.plan
                              return <Fragment key={pd}><td className={`text-right px-2 py-2 tabular-nums font-semibold border-l border-gray-200 ${fm ? 'text-gray-400 italic' : 'text-blue-700'}`}>{fmt(val)}</td></Fragment>
                            }
                            if (isFactOnly) {
                              return <Fragment key={pd}><td className={`text-right px-2 py-2 tabular-nums font-semibold border-l border-gray-200 ${future ? 'text-gray-300' : g.fact >= 0 ? 'text-gray-800' : 'text-red-600'}`}>{future ? '—' : fmt(g.fact)}</td></Fragment>
                            }
                            return (
                              <Fragment key={pd}>
                                <td className="text-right px-2 py-2 tabular-nums text-blue-700 font-semibold border-l border-gray-200">{fmt(g.plan)}</td>
                                <td className={`text-right px-2 py-2 tabular-nums font-semibold ${future ? 'text-gray-300' : g.fact >= 0 ? 'text-gray-800' : 'text-red-600'}`}>{future ? '—' : fmt(g.fact)}</td>
                                {showDelta && <DeltaCell fact={future ? null : g.fact} plan={g.plan} />}
                              </Fragment>
                            )
                          }) : periodDates.map(pd => <Fragment key={pd}>{Array(colsPerMonth).fill(null).map((_, j) => <td key={j} />)}</Fragment>)}
                        </tr>
                        {/* Inline-форма создания новой статьи */}
                        {addArticle?.groupKey === article.groupKey && (
                          <tr className="border-b border-blue-100 bg-blue-50/40">
                            <td colSpan={1 + periodDates.length * colsPerMonth} className="px-4 py-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <input className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-44" placeholder="Название новой статьи"
                                  value={addArticle.name} onChange={e => setAddArticle(prev => ({ ...prev, name: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') createArticle(); if (e.key === 'Escape') setAddArticle(null) }}
                                  autoFocus />
                                <select className="px-2 py-1 border border-gray-200 rounded text-xs bg-white text-gray-600 w-40"
                                  value={addArticle.parent_id} onChange={e => setAddArticle(prev => ({ ...prev, parent_id: e.target.value }))}>
                                  <option value="">— Без родителя</option>
                                  {getGroupArticleOptions(article.groupKey).map(o => (
                                    <option key={o.id} value={o.id}>{'\u00A0'.repeat(o.depth * 2)}{o.depth > 0 ? '└ ' : ''}{o.name}</option>
                                  ))}
                                </select>
                                <input className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-16 text-center" type="number" placeholder="Порядок"
                                  value={addArticle.sort_order} onChange={e => setAddArticle(prev => ({ ...prev, sort_order: parseInt(e.target.value) || 0 }))} />
                                <button onClick={createArticle} disabled={!addArticle.name.trim() || articleSaving}
                                  className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">{articleSaving ? '...' : 'Создать'}</button>
                                <button onClick={() => setAddArticle(null)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700">Отмена</button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  }
                  const isParent = article.hasChildren
                  const isEditing = editArticle?.id === article.id
                  return (
                    <Fragment key={article.id}>
                    <tr className={`border-b border-gray-50 hover:bg-gray-50/50 ${isParent ? 'bg-gray-50/50 font-medium' : ''} group/row`}>
                      <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-gray-700 whitespace-nowrap" style={{ paddingLeft: 12 + article.depth * 20 }}>
                        <div className="flex items-center gap-1">
                          {isParent && (
                            <button onClick={() => toggleExpand(article.id)} className="text-gray-400 hover:text-gray-600 transition-colors w-4 flex items-center justify-center">
                              <svg className={`w-2.5 h-2.5 transition-transform duration-200 ${expanded.has(article.id) ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </button>
                          )}
                          <span className={article.depth === 0 ? 'font-medium' : ''}>{article.depth > 0 && !isParent && <span className="text-gray-300 mr-1">└</span>}{article.name}</span>
                          <button
                            onClick={() => openEditArticle(article)}
                            className="opacity-0 group-hover/row:opacity-100 transition-opacity text-gray-300 hover:text-gray-500 p-0.5 ml-1"
                            title="Редактировать статью"
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                          </button>
                        </div>
                      </td>
                      {periodDates.map(pd => {
                        const sec = article.section || null
                        const factVal = getArticleValue(article.id, pd, fact, sec)
                        const planVal = getArticleValue(article.id, pd, plan, sec)
                        const future = isFutureMonth(pd)
                        const editable = selectedDoc?.status === 'draft'
                        const key = sec ? `${sec}:${article.id}:0:${pd}` : `${article.id}:0:${pd}`
                        const count = planDetails[key]?.length || 0
                        const isCopied = clipboard && clipboard.articleId === article.id && clipboard.periodDate === pd && clipboard.section === sec
                        const canPaste = !!clipboard && clipboard.articleId === article.id && clipboard.section === sec && clipboard.periodDate !== pd
                        return (
                          <Fragment key={pd}>
                            {isPlanOnly ? (
                              isFactMonth(pd)
                                ? <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 italic border-l border-gray-100">{fmt(factVal)}</td>
                                : editable ? <PlanCell value={planVal} detailCount={count} disabled={false}
                                    onClick={() => openDrawer(article.id, article.name, pd, 'plan', sec)}
                                    isCopied={isCopied} onCopy={() => handleCopyCell(article.id, article.name, pd, sec)}
                                    onPaste={canPaste ? () => handlePasteCell(article.id, pd, sec) : null} canPaste={canPaste} onClearClipboard={() => setClipboard(null)} />
                                  : <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(planVal)}</td>
                            ) : isFactOnly ? (
                              <FactCell value={factVal} future={future} onClick={factVal && !future ? () => openDrawer(article.id, article.name, pd, 'fact', sec) : null} />
                            ) : (
                              <>
                                {editable ? <PlanCell value={planVal} detailCount={count} disabled={false}
                                  onClick={() => openDrawer(article.id, article.name, pd, 'plan', sec)}
                                  isCopied={isCopied} onCopy={() => handleCopyCell(article.id, article.name, pd, sec)}
                                  onPaste={canPaste ? () => handlePasteCell(article.id, pd, sec) : null} canPaste={canPaste} onClearClipboard={() => setClipboard(null)} />
                                  : <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(planVal)}</td>}
                                <FactCell value={factVal} future={future} onClick={factVal && !future ? () => openDrawer(article.id, article.name, pd, 'fact', sec) : null} />
                                {showDelta && <DeltaCell fact={future ? null : factVal} plan={planVal} />}
                              </>
                            )}
                          </Fragment>
                        )
                      })}
                    </tr>
                    {/* Inline-панель редактирования статьи */}
                    {isEditing && (
                      <tr className="border-b border-blue-100 bg-blue-50/40">
                        <td colSpan={1 + periodDates.length * colsPerMonth} className="px-4 py-2">
                          <div className="flex items-center gap-2 flex-wrap" style={{ paddingLeft: article.depth * 20 }}>
                            <input className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-44" placeholder="Название"
                              value={editArticle.name} onChange={e => setEditArticle(prev => ({ ...prev, name: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') saveArticle(); if (e.key === 'Escape') setEditArticle(null) }}
                              autoFocus />
                            <select className="px-2 py-1 border border-gray-200 rounded text-xs bg-white text-gray-600 w-40"
                              value={editArticle.parent_id} onChange={e => setEditArticle(prev => ({ ...prev, parent_id: e.target.value }))}>
                              <option value="">— Без родителя</option>
                              {getGroupArticleOptions(article.section || article.groupKey).filter(o => o.id !== article.id).map(o => (
                                <option key={o.id} value={o.id}>{'\u00A0'.repeat(o.depth * 2)}{o.depth > 0 ? '└ ' : ''}{o.name}</option>
                              ))}
                            </select>
                            <input className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-16 text-center" type="number" placeholder="Порядок"
                              value={editArticle.sort_order} onChange={e => setEditArticle(prev => ({ ...prev, sort_order: parseInt(e.target.value) || 0 }))} />
                            <button onClick={saveArticle} disabled={!editArticle.name.trim() || articleSaving}
                              className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">{articleSaving ? '...' : 'OK'}</button>
                            <button onClick={() => setEditArticle(null)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700">Отмена</button>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}

                {/* БДР: Чистая прибыль */}
                {selectedDoc?.type === 'bdr' && bdrGroupTotals.revenue && (
                  renderProfitRow('Чистая прибыль', (pd) => {
                    const rev = bdrGroupTotals.revenue?.[pd] || { fact: 0, plan: 0 }
                    const cost = bdrGroupTotals.cost?.[pd] || { fact: 0, plan: 0 }
                    const exp = bdrGroupTotals.expenses?.[pd] || { fact: 0, plan: 0 }
                    return { factVal: rev.fact + cost.fact + exp.fact, planVal: rev.plan + cost.plan + exp.plan }
                  }, 'border-t-2 border-gray-300')
                )}

                {/* ДДС: Движение */}
                {selectedDoc?.type === 'dds' && (
                  <tr className="bg-gray-50 font-semibold border-t border-gray-200">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">02 Движение</td>
                    {periodDates.map((pd, i) => { const fb = factBalances[i], pb = planBalances[i]; if (!fb || !pb) return <Fragment key={pd}>{Array(colsPerMonth).fill(null).map((_, j) => <td key={j} />)}</Fragment>; const future = isFutureMonth(pd); const fm = isFactMonth(pd)
                      if (isPlanOnly) { const val = fm ? fb.move : pb.move; return <Fragment key={pd}><td className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${fm ? 'text-gray-400 italic' : 'text-blue-600'}`}>{fmt(val)}</td></Fragment> }
                      if (isFactOnly) { return <Fragment key={pd}><td className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${future ? 'text-gray-300' : fb.move >= 0 ? 'text-gray-700' : 'text-red-600'}`}>{future ? '—' : fmt(fb.move)}</td></Fragment> }
                      return <Fragment key={pd}><td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.move)}</td><td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : fb.move >= 0 ? 'text-gray-700' : 'text-red-600'}`}>{future ? '—' : fmt(fb.move)}</td>{showDelta && <DeltaCell fact={future ? null : fb.move} plan={pb.move} />}</Fragment>
                    })}
                  </tr>
                )}

                {/* ДДС: Остаток на конец */}
                {selectedDoc?.type === 'dds' && (<>
                  <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">03 Остаток на конец</td>
                    {periodDates.map((pd, i) => { const fb = factBalances[i], pb = planBalances[i]; if (!fb || !pb) return <Fragment key={pd}>{Array(colsPerMonth).fill(null).map((_, j) => <td key={j} />)}</Fragment>; const future = isFutureMonth(pd); const fm = isFactMonth(pd)
                      if (isPlanOnly) { const val = fm ? fb.closing : pb.closing; return <Fragment key={pd}><td className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${fm ? 'text-gray-400 italic' : 'text-blue-600'}`}>{fmt(val)}</td></Fragment> }
                      if (isFactOnly) { return <Fragment key={pd}><td className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${future ? 'text-gray-300' : 'text-gray-700'}`}>{future ? '—' : fmt(fb.closing)}</td></Fragment> }
                      return <Fragment key={pd}><td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.closing)}</td><td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : 'text-gray-700'}`}>{future ? '—' : fmt(fb.closing)}</td>{showDelta && <DeltaCell fact={future ? null : fb.closing} plan={pb.closing} />}</Fragment>
                    })}
                  </tr>
                  {byCash && cashItems.map(ci => <tr key={`cc_${ci.id}`} className="border-b border-gray-50"><td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-500 text-[11px]" style={{ paddingLeft: 28 }}>└ {ci.name}</td>{periodDates.map((pd, i) => { const cb = cashBalances[ci.id]?.[i]
                    if (isPlanOnly) return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.closing)}</td></Fragment>
                    if (isFactOnly) return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px] border-l border-gray-100">{fmt(cb?.closing)}</td></Fragment>
                    return <Fragment key={pd}><td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.closing)}</td><td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px]">{fmt(cb?.closing)}</td>{showDelta && <td />}</Fragment> })}</tr>)}
                </>)}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-gray-100 flex gap-5 text-[11px] text-gray-400">
            {showPlan && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> План{!isFactOnly && ' (клик для деталей)'}</span>}
            {showFact && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500" /> Факт{!isPlanOnly && ' (клик для расшифровки)'}</span>}
            {showDelta && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Δ отклонение</span>}
            {isPlanOnly && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-300" /> <em>курсив = факт за прошлые месяцы</em></span>}
          </div>
        </div>
      )}

      {drawer && (
        <BudgetDrawer
          mode={drawer.mode}
          articleId={drawer.articleId}
          articleName={drawer.articleName}
          periodDate={drawer.periodDate}
          periodLabel={drawer.periodLabel}
          section={drawer.section}
          docId={selectedDocId}
          docType={selectedDoc?.type}
          articles={report?.articles}
          descendantAllMap={descendantAllMap}
          periodDates={periodDates}
          granularity="month"
          factDrillConfig={report?.fact_drill_config}
          onClose={() => setDrawer(null)}
          onUpdate={() => loadReport(true)}
        />
      )}

      {showCreateModal && <CreateDocModal projects={projects} onClose={() => setShowCreateModal(false)} onCreate={(doc) => { setDocuments(prev => [doc, ...prev]); setSelectedDocId(doc.id); setShowCreateModal(false) }} />}
    </Layout>
  )
}
