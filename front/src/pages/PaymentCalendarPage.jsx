import { Fragment, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  getBudgetDocuments, createBudgetDocument, updateBudgetDocument,
  getBudgetReport, getBudgetItems, createBudgetItem, deleteBudgetItem, upsertOpeningBalance,
} from '../api/budget'
import Layout from '../components/Layout'
import BudgetDrawer from '../components/budget/BudgetDrawer'

// ── Утилиты ────────────────────────────────────────────────────────────────
const fmt = (v) => { if (v == null || v === '' || isNaN(v)) return ''; return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) }
const todayISO = () => new Date().toISOString().slice(0, 10)
const isToday = (ds) => ds === todayISO()
const isPast = (ds) => ds < todayISO()
const isFuture = (ds) => ds > todayISO()

// День недели (0 = вс, 1 = пн, ...)
const dayOfWeek = (ds) => new Date(ds + 'T00:00:00').getDay()
const isWeekend = (ds) => { const w = dayOfWeek(ds); return w === 0 || w === 6 }

// Подписи
const monthLabel = (ds) => new Date(ds + 'T00:00:00').toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
const dayShort = (ds) => { const d = new Date(ds + 'T00:00:00'); return d.getDate() }
const dowShort = (ds) => ['вс','пн','вт','ср','чт','пт','сб'][dayOfWeek(ds)]
const monthShort = (ds) => new Date(ds + 'T00:00:00').toLocaleString('ru-RU', { month: 'short' })

// ── Дерево статей ──────────────────────────────────────────────────────────
const flattenArticles = (articles, depth = 0) => {
  const r = []
  for (const a of articles) {
    r.push({ ...a, depth, hasChildren: !!(a.children?.length) })
    if (a.children) r.push(...flattenArticles(a.children, depth + 1))
  }
  return r
}

const buildDescendantAllMap = (articles) => {
  const map = {}
  const collect = (n) => {
    const s = new Set([n.id])
    if (n.children?.length) for (const c of n.children) for (const d of collect(c)) s.add(d)
    map[n.id] = s
    return s
  }
  for (const a of articles) collect(a)
  return map
}

// ── Модалка создания PDC ────────────────────────────────────────────────────
function CreatePdcModal({ projects, onClose, onCreate }) {
  const [name, setName] = useState('')
  const [projectId, setProjectId] = useState(projects[0]?.id || '')
  const [periodFrom, setPeriodFrom] = useState(() => todayISO())
  const [periodTo, setPeriodTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10)
  })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!name.trim() || !projectId) return
    setSaving(true)
    try {
      const r = await createBudgetDocument({
        name, type: 'pdc',
        period_from: periodFrom, period_to: periodTo, project_id: projectId,
      })
      onCreate(r.data.data)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="p-6 border-b border-gray-100"><h3 className="text-lg font-semibold text-gray-800">Новый платёжный календарь</h3></div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Название</label>
            <input className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={name} onChange={e => setName(e.target.value)} placeholder="Календарь на октябрь 2026" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Проект</label>
            <select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={projectId} onChange={e => setProjectId(e.target.value)}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Период с</label>
              <input type="date" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={periodFrom} onChange={e => setPeriodFrom(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Период по</label>
              <input type="date" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={periodTo} onChange={e => setPeriodTo(e.target.value)} />
            </div>
          </div>
          <div className="text-[11px] text-gray-400">
            Подсказка: для удобной работы выбирайте горизонт 2–8 недель. Длинный горизонт (несколько месяцев) лучше смотреть в режиме «Месяц».
          </div>
        </div>
        <div className="p-6 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Отмена</button>
          <button onClick={handleSubmit} disabled={saving || !name.trim()} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50">
            {saving ? 'Создаю...' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
export default function PaymentCalendarPage() {
  const navigate = useNavigate()
  const [documents, setDocuments] = useState([])
  const [selectedDocId, setSelectedDocId] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [byCash, setByCash] = useState(false)
  const [granularity, setGranularity] = useState('day') // 'day' | 'month'
  const [viewMode, setViewMode] = useState('plan_fact') // 'plan' | 'fact' | 'plan_fact'
  const [expanded, setExpanded] = useState(new Set())
  const [drawer, setDrawer] = useState(null)
  const [editDoc, setEditDoc] = useState(null)
  const [showSettingsPopup, setShowSettingsPopup] = useState(false)
  const [clipboard, setClipboard] = useState(null) // { articleId, periodDate, articleName }
  const [pasting, setPasting] = useState(false)
  const [displayFrom, setDisplayFrom] = useState('') // расширение влево для показа факта прошлых периодов

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    api.get('/projects').then(r => setProjects(r.data.data || r.data))
    loadDocuments()
  }, [])

  const loadDocuments = async () => {
    const r = await getBudgetDocuments({ type: 'pdc' })
    const d = r.data.data || []
    setDocuments(d)
    if (d.length > 0 && !selectedDocId) setSelectedDocId(d[0].id)
  }

  useEffect(() => { if (selectedDocId) loadReport() }, [selectedDocId, byCash, granularity, displayFrom])

  const loadReport = async (keepState = false) => {
    if (!keepState) setLoading(true)
    try {
      const params = { by_cash: byCash ? 1 : 0, granularity }
      if (displayFrom) params.display_from = displayFrom
      const r = await getBudgetReport(selectedDocId, params)
      setReport(r.data)
      if (!keepState) {
        const rootIds = new Set()
        const arts = r.data.articles
        if (Array.isArray(arts)) arts.forEach(a => rootIds.add(a.id))
        setExpanded(rootIds)
      }
    } finally { if (!keepState) setLoading(false) }
  }

  const toggleExpand = (id) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const openDrawer = (articleId, articleName, periodDate) => {
    const label = granularity === 'day'
      ? new Date(periodDate + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : monthLabel(periodDate)
    setDrawer({ articleId, articleName, periodDate, periodLabel: label })
  }

  // ── Копирование / вставка плана между периодами (по ПКМ) ───────────────────
  const handleCopyCell = (articleId, articleName, periodDate) => {
    setClipboard({ articleId, articleName, periodDate })
  }

  const handlePasteCell = async (targetArticleId, targetPeriodDate) => {
    if (!clipboard) return
    if (clipboard.articleId !== targetArticleId) return
    setPasting(true)
    try {
      const srcIds = descendantAllMap[clipboard.articleId]
      const ids = srcIds && srcIds.size > 0 ? [...srcIds] : [clipboard.articleId]
      // 1. Загружаем строки источника
      const res = await getBudgetItems({
        budget_document_id: selectedDocId,
        article_ids: ids.join(','),
        period_date: clipboard.periodDate,
      })
      const srcRows = res.data.data || []
      if (srcRows.length === 0) { setPasting(false); return }
      // 2. Удаляем существующие в целевом периоде
      const existing = await getBudgetItems({
        budget_document_id: selectedDocId,
        article_ids: ids.join(','),
        period_date: targetPeriodDate,
      })
      for (const row of (existing.data.data || [])) {
        await deleteBudgetItem(row.id)
      }
      // 3. Создаём копии
      for (const row of srcRows) {
        await createBudgetItem({
          budget_document_id: selectedDocId,
          article_id: row.article_id,
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

  const selectedDoc = documents.find(d => d.id === selectedDocId)
  const periodDates = report?.period_dates || []
  const plan = report?.plan || {}
  const fact = report?.fact || {}
  const openBal = report?.opening_balances || {}
  const cashItems = report?.cash_items || []
  const factDrillConfig = report?.fact_drill_config || {}

  // Дерево статей
  const { flatArticles, descendantAllMap } = useMemo(() => {
    if (!report?.articles) return { flatArticles: [], descendantAllMap: {} }
    const arts = report.articles
    return {
      flatArticles: flattenArticles(arts),
      descendantAllMap: buildDescendantAllMap(arts),
    }
  }, [report])

  // Видимые статьи (с учётом раскрытия)
  const visibleArticles = useMemo(() => {
    const r = []; let skip = null
    for (const a of flatArticles) {
      if (skip !== null && a.depth > skip) continue
      skip = null
      r.push(a)
      if (a.hasChildren && !expanded.has(a.id)) skip = a.depth
    }
    return r
  }, [flatArticles, expanded])

  // Получить значение по статье + всем потомкам в указанном периоде
  const getArticleValue = useCallback((aid, pd, src) => {
    const allIds = descendantAllMap[aid]
    const ids = (allIds?.size > 0) ? allIds : new Set([aid])
    let t = 0; const sfx = ':' + pd
    for (const l of ids) {
      const p = l + ':'
      for (const [k, v] of Object.entries(src)) {
        if (k.startsWith(p) && k.endsWith(sfx)) t += v
      }
    }
    return t
  }, [descendantAllMap])

  const calcPeriodTotal = useCallback((pd, src) => {
    let t = 0; const sfx = ':' + pd
    for (const [k, v] of Object.entries(src)) if (k.endsWith(sfx)) t += v
    return t
  }, [])

  // Остаток на начало
  const autoOpening = useMemo(() => {
    const ob0 = openBal[0] || openBal['0']
    const generalAuto = ob0?.auto ?? 0
    if (generalAuto !== 0) return generalAuto
    let t = 0; for (const [, v] of Object.entries(openBal)) t += (v?.auto ?? 0)
    return t
  }, [openBal])

  const manualOpening = useMemo(() => {
    const ob = openBal[0] || openBal['0']
    return ob?.is_manual ? (ob.manual ?? null) : null
  }, [openBal])

  const planOpeningAmount = manualOpening !== null ? manualOpening : autoOpening

  // Балансы по периодам: для прошедших дней берём факт, для будущих — план
  // (для платёжного календаря важно: сегодня и далее — план, до сегодня — факт)
  const balances = useMemo(() => {
    const r = []
    let p = planOpeningAmount
    for (const pd of periodDates) {
      const o = p
      // в дневном режиме: прошлое = факт, сегодня и будущее = план
      // в месячном: прошлый/текущий месяц = факт, будущие = план
      const usePlan = granularity === 'day' ? !isPast(pd) : (() => {
        const now = new Date()
        const d = new Date(pd + 'T00:00:00')
        return d.getFullYear() > now.getFullYear() ||
               (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())
      })()
      const m = usePlan ? calcPeriodTotal(pd, plan) : calcPeriodTotal(pd, fact)
      r.push({ opening: o, move: m, closing: o + m, usePlan })
      p = o + m
    }
    return r
  }, [periodDates, plan, fact, planOpeningAmount, calcPeriodTotal, granularity])

  // Балансы по кассам (если byCash)
  const cashOpenings = useMemo(() => {
    if (!byCash) return {}
    const r = {}
    for (const [c, ob] of Object.entries(openBal)) r[c] = ob?.auto ?? 0
    return r
  }, [openBal, byCash])

  const cashBalances = useMemo(() => {
    if (!byCash || !cashItems.length) return {}
    const r = {}
    for (const ci of cashItems) {
      const arr = []
      let p = cashOpenings[ci.id] ?? cashOpenings[String(ci.id)] ?? 0
      for (const pd of periodDates) {
        const o = p
        let m = 0
        const usePlan = granularity === 'day' ? !isPast(pd) : (() => {
          const now = new Date()
          const d = new Date(pd + 'T00:00:00')
          return d.getFullYear() > now.getFullYear() ||
                 (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())
        })()
        const src = usePlan ? plan : fact
        for (const [k, v] of Object.entries(src)) {
          if (k.split(':')[1] === String(ci.id) && k.endsWith(':' + pd)) m += v
        }
        arr.push({ opening: o, move: m, closing: o + m })
        p = o + m
      }
      r[ci.id] = arr
    }
    return r
  }, [byCash, cashItems, cashOpenings, periodDates, plan, fact, granularity])

  const showPlan = viewMode === 'plan' || viewMode === 'plan_fact'
  const showFact = viewMode === 'fact' || viewMode === 'plan_fact'

  // Сохранение настроек документа
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
        return filtered
      })
    } else {
      setDocuments(prev => prev.map(d => d.id === selectedDocId ? { ...d, status: newStatus } : d))
    }
  }

  // Сохранение остатка на начало
  const saveOpeningBalance = useCallback(async (amount) => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount, is_manual: true })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: amount, is_manual: true } } } : prev)
  }, [selectedDocId])

  const resetOpeningBalance = useCallback(async () => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount: autoOpening, is_manual: false })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: null, is_manual: false } } } : prev)
  }, [selectedDocId, autoOpening])

  // Ширина колонки периода
  const colWidth = granularity === 'day' ? 70 : 110
  const totalWidth = 280 + periodDates.length * colWidth

  return (
    <Layout>
      {/* Шапка */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-xl font-bold text-gray-800 mr-2">Платёжный календарь</h1>

        {/* Селектор документа */}
        <select
          className={`px-3 py-2 border rounded-lg text-sm bg-white min-w-[260px] ${
            selectedDoc?.status === 'approved' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' :
            selectedDoc?.status === 'archived' ? 'border-gray-300 bg-gray-100 text-gray-500' :
            'border-gray-200 text-gray-700'
          }`}
          value={selectedDocId || ''}
          onChange={e => setSelectedDocId(parseInt(e.target.value) || null)}
        >
          <option value="">— Выберите календарь —</option>
          {documents.map(d => (
            <option key={d.id} value={d.id}>
              {d.name} ({new Date(d.period_from).toLocaleDateString('ru-RU')} – {new Date(d.period_to).toLocaleDateString('ru-RU')})
            </option>
          ))}
        </select>

        {/* Шестерёнка настроек */}
        {selectedDoc && (
          <div className="relative">
            <button onClick={() => setShowSettingsPopup(s => !s)} className="px-2 py-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg" title="Настройки">⚙</button>
            {showSettingsPopup && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => { setShowSettingsPopup(false); setEditDoc(null) }} />
                <div className="absolute top-full left-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-40 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase text-gray-400 tracking-wide">Статус</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                      selectedDoc.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                      selectedDoc.status === 'archived' ? 'bg-gray-200 text-gray-500' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {selectedDoc.status === 'approved' ? 'Утверждён' : selectedDoc.status === 'archived' ? 'Архив' : 'Черновик'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {selectedDoc.status === 'draft' && (
                      <button onClick={() => changeStatus('approved')} className="flex-1 px-3 py-1.5 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700">Утвердить</button>
                    )}
                    {selectedDoc.status === 'approved' && (
                      <button onClick={() => changeStatus('draft')} className="flex-1 px-3 py-1.5 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300">Вернуть в черновик</button>
                    )}
                    <button onClick={() => changeStatus('archived')} className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded">В архив</button>
                  </div>
                  <div className="border-t border-gray-100 pt-3 space-y-2">
                    <div>
                      <label className="block text-[11px] text-gray-500 mb-1">Название</label>
                      <input className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                        value={editDoc?.name ?? selectedDoc.name}
                        onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), name: e.target.value }))}
                        onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-gray-500 mb-1">с</label>
                        <input type="date" className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                          value={editDoc?.period_from ?? selectedDoc.period_from?.slice(0,10)}
                          onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), period_from: e.target.value }))}
                          onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-gray-500 mb-1">по</label>
                        <input type="date" className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
                          value={editDoc?.period_to ?? selectedDoc.period_to?.slice(0,10)}
                          onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), period_to: e.target.value }))}
                          onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                        />
                      </div>
                    </div>
                    {editDoc && (
                      <div className="flex gap-2 pt-1">
                        <button onClick={saveDocSettings} className="flex-1 px-3 py-1.5 text-xs bg-blue-900 text-white rounded">Сохранить</button>
                        <button onClick={() => setEditDoc(null)} className="px-3 py-1.5 text-xs text-gray-500">Отмена</button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Гранулярность */}
        {selectedDoc && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-2">
            <button className={`px-3 py-1.5 text-xs font-medium ${granularity === 'day' ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setGranularity('day')}>День</button>
            <button className={`px-3 py-1.5 text-xs font-medium ${granularity === 'month' ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setGranularity('month')}>Месяц</button>
          </div>
        )}

        {/* По кассам */}
        {selectedDoc && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-1">
            <button className={`px-3 py-1.5 text-xs font-medium ${!byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(false)}>Общая</button>
            <button className={`px-3 py-1.5 text-xs font-medium ${byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(true)}>По кассам</button>
          </div>
        )}

        {/* Режимы отображения */}
        {selectedDoc && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-1">
            {[{k:'plan',l:'План'},{k:'fact',l:'Факт'},{k:'plan_fact',l:'П+Ф'}].map(m => (
              <button key={m.k} className={`px-2.5 py-1.5 text-[11px] font-medium ${viewMode === m.k ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setViewMode(m.k)}>{m.l}</button>
            ))}
          </div>
        )}

        {/* Показать с — расширение влево для показа факта прошлых периодов */}
        {selectedDoc && (
          <div className="flex items-center gap-1.5 ml-2">
            <span className="text-[11px] text-gray-400">Показать с:</span>
            <input type="date" className="px-1.5 py-1 border border-gray-200 rounded text-[11px] bg-white"
              value={displayFrom}
              onChange={e => setDisplayFrom(e.target.value)}
              max={selectedDoc?.period_from?.slice(0, 10)} />
            {displayFrom && <button className="text-[10px] text-gray-400 hover:text-gray-600 ml-0.5" onClick={() => setDisplayFrom('')} title="Сбросить">✕</button>}
          </div>
        )}

        <div className="ml-auto">
          <button onClick={() => setShowCreateModal(true)} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800">+ Новый календарь</button>
        </div>
      </div>

      {/* Период документа */}
      {selectedDoc && (
        <div className="text-[11px] text-gray-400 mb-3 -mt-2">
          {new Date(selectedDoc.period_from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })} —
          {' '}{new Date(selectedDoc.period_to).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
          {' · '}<span>{periodDates.length} {granularity === 'day' ? 'дн.' : 'мес.'}</span>
        </div>
      )}

      {loading ? <div className="text-center py-20 text-gray-400">Загрузка отчёта...</div>
      : !report ? <div className="text-center py-20 text-gray-400">{documents.length === 0 ? 'Создайте первый платёжный календарь' : 'Выберите документ'}</div>
      : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {/* Индикатор буфера обмена */}
          {(clipboard || pasting) && (
            <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
              <span className="text-[11px] text-blue-600">
                {pasting
                  ? 'Вставка...'
                  : <>Скопировано: <span className="font-medium">{clipboard.articleName}</span> / {granularity === 'day' ? new Date(clipboard.periodDate + 'T00:00:00').toLocaleDateString('ru-RU') : monthLabel(clipboard.periodDate)} — ПКМ на ячейку плана для вставки</>
                }
              </span>
              {!pasting && (
                <button onClick={() => setClipboard(null)} className="text-[10px] text-blue-400 hover:text-blue-600">✕ Очистить</button>
              )}
            </div>
          )}
          <div className="overflow-auto max-h-[calc(100vh-260px)]">
            <table className="w-full border-collapse text-xs" style={{ minWidth: `${totalWidth}px` }}>
              <thead className="bg-gray-50 sticky top-0 z-20">
                <tr>
                  <th className="text-left sticky left-0 z-30 bg-gray-50 px-3 py-2 font-medium text-gray-500 border-b border-gray-200" style={{ width: 280 }}>Статья</th>
                  {periodDates.map(pd => {
                    const today = isToday(pd) && granularity === 'day'
                    const weekend = granularity === 'day' && isWeekend(pd)
                    return (
                      <th key={pd} className={`text-center px-1 py-1.5 font-medium border-b border-l border-gray-200 ${
                        today ? 'bg-blue-100 text-blue-900' :
                        weekend ? 'bg-gray-100 text-gray-400' :
                        'text-gray-600'
                      }`} style={{ width: colWidth, minWidth: colWidth }}>
                        {granularity === 'day' ? (
                          <div className="flex flex-col items-center leading-tight">
                            <span className="text-[10px] uppercase">{dowShort(pd)}</span>
                            <span className="text-sm font-semibold">{dayShort(pd)}</span>
                            <span className="text-[9px] text-gray-400">{monthShort(pd)}</span>
                          </div>
                        ) : (
                          <div className="text-[11px] capitalize">{monthLabel(pd)}</div>
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {/* Остаток на начало (с возможностью редактирования первого) */}
                <tr className="bg-gray-50 border-b border-gray-200">
                  <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 font-semibold text-gray-700">
                    01 Остаток на начало
                  </td>
                  {periodDates.map((pd, i) => {
                    const b = balances[i]
                    if (!b) return <td key={pd} />
                    const today = isToday(pd) && granularity === 'day'
                    const weekend = granularity === 'day' && isWeekend(pd)
                    const isFirst = i === 0
                    return (
                      <td key={pd} className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${
                        today ? 'bg-blue-50' : weekend ? 'bg-gray-50' : ''
                      } ${b.opening < 0 ? 'text-red-600 font-semibold' : 'text-gray-700'}`}>
                        {isFirst ? (
                          <OpeningBalanceCell value={b.opening} isManual={manualOpening !== null} onSave={saveOpeningBalance} onReset={resetOpeningBalance} />
                        ) : fmt(b.opening)}
                      </td>
                    )
                  })}
                </tr>

                {/* Дерево статей */}
                {visibleArticles.map(article => {
                  const isParent = article.hasChildren
                  return (
                    <tr key={article.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${isParent ? 'bg-gray-50/30 font-medium' : ''}`}>
                      <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-gray-700 whitespace-nowrap" style={{ paddingLeft: 12 + article.depth * 20 }}>
                        <div className="flex items-center gap-1">
                          {isParent && (
                            <button onClick={() => toggleExpand(article.id)} className="text-gray-400 hover:text-gray-600 w-4 flex items-center justify-center">
                              <svg className={`w-2.5 h-2.5 transition-transform ${expanded.has(article.id) ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </button>
                          )}
                          <span className={article.depth === 0 ? 'font-medium text-gray-800' : 'text-gray-600'}>{article.name}</span>
                        </div>
                      </td>
                      {periodDates.map(pd => {
                        const planVal = getArticleValue(article.id, pd, plan)
                        const factVal = getArticleValue(article.id, pd, fact)
                        const today = isToday(pd) && granularity === 'day'
                        const weekend = granularity === 'day' && isWeekend(pd)
                        const future = isFuture(pd)
                        const cellBg = today ? 'bg-blue-50' : weekend ? 'bg-gray-50' : ''
                        const isCopied = clipboard && clipboard.articleId === article.id && clipboard.periodDate === pd
                        const canPaste = !!clipboard && clipboard.articleId === article.id && clipboard.periodDate !== pd
                        const copiedCls = isCopied ? 'outline outline-2 outline-dashed outline-blue-400 outline-offset-[-2px]' : ''

                        // Хендлеры для ячейки плана: ЛКМ — drawer, ПКМ — копирование/вставка
                        const planClick = () => { if (clipboard) setClipboard(null); openDrawer(article.id, article.name, pd) }
                        const planContext = (e) => {
                          e.preventDefault()
                          if (canPaste) handlePasteCell(article.id, pd)
                          else handleCopyCell(article.id, article.name, pd)
                        }

                        if (viewMode === 'plan') {
                          return (
                            <td key={pd}
                              className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 cursor-pointer hover:bg-blue-50 ${cellBg} ${copiedCls} ${planVal ? 'text-blue-700' : 'text-gray-300'}`}
                              onClick={planClick}
                              onContextMenu={planContext}
                              title={canPaste ? 'ПКМ — вставить' : isCopied ? 'Скопировано — ПКМ на другой ячейке для вставки' : 'ЛКМ — редактировать, ПКМ — скопировать'}>
                              {fmt(planVal)}
                            </td>
                          )
                        }
                        if (viewMode === 'fact') {
                          return (
                            <td key={pd} className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${cellBg} ${future ? 'text-gray-300' : factVal < 0 ? 'text-red-600' : factVal > 0 ? 'text-gray-700' : 'text-gray-300'} ${factVal && !future ? 'cursor-pointer hover:bg-gray-100' : ''}`}
                              onClick={() => factVal && !future && openDrawer(article.id, article.name, pd)}>
                              {future ? '—' : fmt(factVal)}
                            </td>
                          )
                        }
                        // plan_fact: верх — план (с copy/paste), низ — факт (с drill-down)
                        const factClickable = factVal && !future
                        return (
                          <td key={pd} className={`px-0 py-0 border-l border-gray-100 ${cellBg} ${copiedCls}`}>
                            <div className="flex flex-col leading-tight">
                              <button
                                onClick={planClick}
                                onContextMenu={planContext}
                                title={canPaste ? 'ПКМ — вставить план' : isCopied ? 'Скопировано — ПКМ на другой ячейке' : 'ЛКМ — план, ПКМ — копировать'}
                                className={`text-[11px] tabular-nums text-right px-2 py-1 hover:bg-blue-50 ${planVal ? 'text-blue-700 font-medium' : 'text-gray-300'}`}>
                                {fmt(planVal) || '\u00A0'}
                              </button>
                              <button
                                onClick={() => factClickable && openDrawer(article.id, article.name, pd)}
                                disabled={!factClickable}
                                className={`text-[10px] tabular-nums text-right px-2 pb-1 ${
                                  future ? 'text-gray-300' :
                                  factVal < 0 ? 'text-red-600' :
                                  factVal > 0 ? 'text-gray-600' :
                                  'text-gray-300'
                                } ${factClickable ? 'hover:bg-gray-100 cursor-pointer' : 'cursor-default'}`}>
                                {future ? '—' : (fmt(factVal) || '\u00A0')}
                              </button>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}

                {/* Движение */}
                <tr className="bg-gray-50 font-semibold border-t border-gray-200">
                  <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">02 Движение</td>
                  {periodDates.map((pd, i) => {
                    const b = balances[i]; if (!b) return <td key={pd} />
                    const today = isToday(pd) && granularity === 'day'
                    const weekend = granularity === 'day' && isWeekend(pd)
                    return (
                      <td key={pd} className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${
                        today ? 'bg-blue-50' : weekend ? 'bg-gray-50' : ''
                      } ${b.move < 0 ? 'text-red-600' : b.move > 0 ? 'text-gray-700' : 'text-gray-400'} ${b.usePlan ? 'italic' : ''}`}
                        title={b.usePlan ? 'План' : 'Факт'}>
                        {fmt(b.move)}
                      </td>
                    )
                  })}
                </tr>

                {/* Остаток на конец — главная строка платёжного календаря */}
                <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                  <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">03 Остаток на конец</td>
                  {periodDates.map((pd, i) => {
                    const b = balances[i]; if (!b) return <td key={pd} />
                    const today = isToday(pd) && granularity === 'day'
                    const weekend = granularity === 'day' && isWeekend(pd)
                    const gap = b.closing < 0 // КАССОВЫЙ РАЗРЫВ
                    return (
                      <td key={pd} className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${
                        gap ? 'bg-red-100 text-red-700 font-bold' :
                        today ? 'bg-blue-100 text-blue-900' :
                        weekend ? 'bg-gray-100 text-gray-600' :
                        'text-gray-800'
                      }`}
                        title={gap ? '⚠ Кассовый разрыв!' : ''}>
                        {gap && '⚠ '}{fmt(b.closing)}
                      </td>
                    )
                  })}
                </tr>

                {/* По кассам */}
                {byCash && cashItems.map(ci => (
                  <tr key={`cc_${ci.id}`} className="border-b border-gray-50">
                    <td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-500 text-[11px]" style={{ paddingLeft: 28 }}>└ {ci.name}</td>
                    {periodDates.map((pd, i) => {
                      const cb = cashBalances[ci.id]?.[i]
                      const gap = cb && cb.closing < 0
                      return (
                        <td key={pd} className={`text-right px-2 py-1 tabular-nums text-[11px] border-l border-gray-100 ${gap ? 'bg-red-50 text-red-600 font-medium' : 'text-gray-500'}`}>
                          {fmt(cb?.closing)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Легенда */}
          <div className="px-4 py-3 border-t border-gray-100 flex gap-5 text-[11px] text-gray-400 flex-wrap">
            {showPlan && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> План (ЛКМ — править · ПКМ — копировать/вставить)</span>}
            {showFact && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500" /> Факт (клик для расшифровки)</span>}
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 border border-red-300" /> Кассовый разрыв</span>
            {granularity === 'day' && <>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-100 border border-blue-300" /> Сегодня</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-gray-100 border border-gray-300" /> Выходной</span>
            </>}
            <span className="flex items-center gap-1.5"><em>курсив = прогноз (план)</em></span>
          </div>
        </div>
      )}

      {drawer && (
        <BudgetDrawer
          mode="plan"
          articleId={drawer.articleId}
          articleName={drawer.articleName}
          periodDate={drawer.periodDate}
          periodLabel={drawer.periodLabel}
          section={null}
          docId={selectedDocId}
          docType="pdc"
          articles={report?.articles}
          descendantAllMap={descendantAllMap}
          periodDates={periodDates}
          granularity={granularity}
          factDrillConfig={factDrillConfig}
          onClose={() => setDrawer(null)}
          onUpdate={() => loadReport(true)}
        />
      )}

      {showCreateModal && (
        <CreatePdcModal
          projects={projects}
          onClose={() => setShowCreateModal(false)}
          onCreate={(doc) => { setDocuments(prev => [doc, ...prev]); setSelectedDocId(doc.id); setShowCreateModal(false) }}
        />
      )}
    </Layout>
  )
}

// ── Ячейка остатка на начало (редактируемая) ───────────────────────────────
function OpeningBalanceCell({ value, isManual, onSave, onReset }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const ref = useRef(null)
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])

  const commit = () => {
    setEditing(false)
    const n = parseFloat(text.replace(/\s/g, '').replace(',', '.'))
    if (!isNaN(n) && n !== value) onSave(n)
  }

  if (editing) {
    return (
      <input ref={ref} type="text" className="w-full text-right text-xs px-1 py-0.5 border border-blue-300 rounded bg-white text-blue-700"
        value={text} onChange={e => setText(e.target.value)}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }} />
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`cursor-pointer hover:underline ${isManual ? 'text-blue-700' : ''}`}
        onDoubleClick={() => { setText(String(Math.round(value || 0))); setEditing(true) }}
        title="Двойной клик для редактирования">
        {fmt(value)}
      </span>
      {isManual && <button onClick={onReset} className="text-[10px] text-gray-400 hover:text-gray-700" title="Сбросить к авто">↺</button>}
    </span>
  )
}
