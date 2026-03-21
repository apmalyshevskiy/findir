import { Fragment, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  getBudgetDocuments, createBudgetDocument,
  getBudgetReport, upsertBudgetItem, upsertOpeningBalance,
} from '../api/budget'
import Layout from '../components/Layout'

// ── Утилиты ────────────────────────────────────────────────────────────────
const fmt = (v) => {
  if (v == null || v === '' || isNaN(v)) return ''
  return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 })
}

const monthLabel = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
}

const isCurrentMonth = (dateStr) => {
  const now = new Date()
  const d = new Date(dateStr + 'T00:00:00')
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
}

const isFutureMonth = (dateStr) => {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  return new Date(dateStr + 'T00:00:00') > first
}

// ── Дерево ─────────────────────────────────────────────────────────────────
const flattenArticles = (articles, depth = 0) => {
  const result = []
  for (const a of articles) {
    result.push({ ...a, depth, hasChildren: !!(a.children?.length) })
    if (a.children) result.push(...flattenArticles(a.children, depth + 1))
  }
  return result
}

const buildDescendantLeafMap = (articles) => {
  const map = {}
  const collect = (node) => {
    if (!node.children || node.children.length === 0) {
      map[node.id] = new Set([node.id])
      return map[node.id]
    }
    const s = new Set()
    for (const ch of node.children) {
      for (const lid of collect(ch)) s.add(lid)
    }
    map[node.id] = s
    return s
  }
  for (const a of articles) collect(a)
  return map
}

// ── Дельта ─────────────────────────────────────────────────────────────────
// plan > 0 (доход): fact > plan → зелёный +, fact < plan → красный -
// plan < 0 (расход): fact > plan (т.е. -80 > -100, потратили меньше) → красный +, fact < plan → зелёный -
function DeltaCell({ fact, plan }) {
  if (fact == null || !plan) return <td className="px-1 py-1.5 text-right text-[10px]" />
  const diff = fact - plan
  const pct = (diff / Math.abs(plan)) * 100
  if (!isFinite(pct) || Math.round(pct) === 0) return <td className="px-1 py-1.5 text-right text-[10px] text-gray-400">0%</td>

  const rounded = Math.round(pct)
  const text = `${rounded > 0 ? '+' : ''}${rounded}%`

  // Определяем "хорошо" или "плохо"
  // Если план положительный (доход): факт больше = хорошо (зелёный)
  // Если план отрицательный (расход): факт больше (ближе к 0) = хорошо? Нет!
  //   план=-100, факт=-80 → diff=+20 → потратили МЕНЬШЕ → зелёный
  //   план=-100, факт=-130 → diff=-30 → потратили БОЛЬШЕ → красный
  // Итого: для расходов diff>0 = хорошо, diff<0 = плохо — то же что для доходов!
  // НО пользователь хочет: расход вырос (по модулю) = красный с +
  //   план=-100, факт=-130 → |факт|>|план| → расход вырос → показываем +30% красным
  //   план=-100, факт=-80  → |факт|<|план| → расход снизился → показываем -20% зелёным
  let isGood, displayPct
  if (plan < 0) {
    // Расходная статья: сравниваем по модулю
    const absDiff = Math.abs(fact) - Math.abs(plan)
    displayPct = Math.round((absDiff / Math.abs(plan)) * 100)
    isGood = displayPct < 0 // расход уменьшился = хорошо
  } else {
    displayPct = rounded
    isGood = rounded > 0
  }
  const displayText = `${displayPct > 0 ? '+' : ''}${displayPct}%`
  if (displayPct === 0) return <td className="px-1 py-1.5 text-right text-[10px] text-gray-400">0%</td>
  const cls = isGood ? 'text-emerald-600' : 'text-red-500'
  return <td className={`px-1 py-1.5 text-right text-[10px] tabular-nums ${cls}`}>{displayText}</td>
}

// ── Редактируемая ячейка ────────────────────────────────────────────────────
function PlanCell({ value, onSave, disabled }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef(null)

  const startEdit = () => {
    if (disabled) return
    setText(value ? String(Math.round(value)) : '')
    setEditing(true)
  }

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  const commit = () => {
    setEditing(false)
    const num = parseFloat(text.replace(/\s/g, '').replace(',', '.')) || 0
    if (num !== (value || 0)) onSave(num)
  }

  if (editing) {
    return (
      <td className="px-1 py-0.5">
        <input ref={inputRef} type="text"
          className="w-full text-right text-xs px-2 py-1 border border-blue-300 rounded bg-white text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
          value={text} onChange={e => setText(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        />
      </td>
    )
  }

  return (
    <td className={`px-2 py-1.5 text-right text-xs tabular-nums ${disabled ? 'text-blue-400' : 'text-blue-600 cursor-pointer hover:bg-blue-50 rounded'}`}
      onDoubleClick={startEdit}>
      {fmt(value)}
    </td>
  )
}

// ── Модалка создания ────────────────────────────────────────────────────────
function CreateDocModal({ projects, onClose, onCreate }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('dds')
  const [projectId, setProjectId] = useState(projects[0]?.id || '')
  const [periodFrom, setPeriodFrom] = useState(() => { const d = new Date(); d.setMonth(0, 1); return d.toISOString().slice(0, 10) })
  const [periodTo, setPeriodTo] = useState(() => { const d = new Date(); d.setMonth(11, 31); return d.toISOString().slice(0, 10) })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!name.trim() || !projectId) return
    setSaving(true)
    try {
      const res = await createBudgetDocument({ name, type, period_from: periodFrom, period_to: periodTo, project_id: projectId })
      onCreate(res.data.data)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="p-6 border-b border-gray-100"><h3 className="text-lg font-semibold text-gray-800">Новый бюджет</h3></div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Название</label>
            <input className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={name} onChange={e => setName(e.target.value)} placeholder="Бюджет ДДС 2026" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Тип</label>
              <select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={type} onChange={e => setType(e.target.value)}>
                <option value="dds">ДДС</option><option value="bdr">БДР</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Проект</label>
              <select className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" value={projectId} onChange={e => setProjectId(e.target.value)}>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
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
  const [documents, setDocuments] = useState([])
  const [selectedDocId, setSelectedDocId] = useState(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [byCash, setByCash] = useState(false)
  const [showDelta, setShowDelta] = useState(false)
  const [expanded, setExpanded] = useState(new Set())

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    api.get('/projects').then(r => setProjects(r.data.data || r.data))
    loadDocuments()
  }, [])

  const loadDocuments = async () => {
    const res = await getBudgetDocuments()
    const docs = res.data.data
    setDocuments(docs)
    if (docs.length > 0 && !selectedDocId) setSelectedDocId(docs[0].id)
  }

  useEffect(() => { if (selectedDocId) loadReport() }, [selectedDocId, byCash])

  const loadReport = async () => {
    setLoading(true)
    try {
      const res = await getBudgetReport(selectedDocId, { by_cash: byCash ? 1 : 0 })
      setReport(res.data)
      const rootIds = new Set()
      const arts = res.data.articles
      if (Array.isArray(arts) && arts[0]?.id != null) arts.forEach(a => rootIds.add(a.id))
      else if (arts) arts.forEach(g => g.items?.forEach(a => rootIds.add(a.id)))
      setExpanded(rootIds)
    } finally { setLoading(false) }
  }

  const savePlanCell = useCallback(async (articleId, periodDate, amount) => {
    await upsertBudgetItem({ budget_document_id: selectedDocId, article_id: articleId, cash_id: null, period_date: periodDate, amount })
    setReport(prev => {
      if (!prev) return prev
      const key = `${articleId}:0:${periodDate}`
      return { ...prev, plan: { ...prev.plan, [key]: amount } }
    })
  }, [selectedDocId])

  const saveOpeningBalance = useCallback(async (amount) => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount, is_manual: true })
    setReport(prev => {
      if (!prev) return prev
      return { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: amount, is_manual: true } } }
    })
  }, [selectedDocId])

  const toggleExpand = (id) => setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const selectedDoc = documents.find(d => d.id === selectedDocId)
  const periodDates = report?.period_dates || []
  const plan = report?.plan || {}
  const fact = report?.fact || {}
  const openBal = report?.opening_balances || {}
  const cashItems = report?.cash_items || []

  // ── Дерево ────────────────────────────────────────────────────────────────
  const { flatArticles, descendantLeafMap } = useMemo(() => {
    if (!report?.articles) return { flatArticles: [], descendantLeafMap: {} }
    const arts = report.articles
    if (Array.isArray(arts) && arts[0]?.id != null) {
      return { flatArticles: flattenArticles(arts), descendantLeafMap: buildDescendantLeafMap(arts) }
    }
    const allItems = [], allFlat = []
    for (const g of arts) {
      allFlat.push({ id: `group_${g.group}`, name: g.label, depth: 0, isGroup: true })
      allFlat.push(...flattenArticles(g.items || [], 1))
      allItems.push(...(g.items || []))
    }
    return { flatArticles: allFlat, descendantLeafMap: buildDescendantLeafMap(allItems) }
  }, [report])

  // ── Суммирование по потомкам (работает с любыми cash_id ключами) ──────────
  const getArticleValue = useCallback((articleId, periodDate, source) => {
    const leafIds = descendantLeafMap[articleId]
    const ids = (leafIds && leafIds.size > 0) ? leafIds : new Set([articleId])
    let total = 0
    const suffix = ':' + periodDate
    for (const lid of ids) {
      const prefix = lid + ':'
      for (const [key, val] of Object.entries(source)) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) total += val
      }
    }
    return total
  }, [descendantLeafMap])

  const calcMonthTotal = useCallback((periodDate, source) => {
    let total = 0
    for (const [key, val] of Object.entries(source)) {
      if (key.endsWith(':' + periodDate)) total += val
    }
    return total
  }, [])

  // ── Остатки ──────────────────────────────────────────────────────────────
  // При byCash: openBal — объект { cash_id: { auto, manual, is_manual } }
  // Суммируем все кассы для общего остатка
  const autoOpening = useMemo(() => {
    if (!byCash) {
      const ob = openBal[0] || openBal['0']
      return ob?.auto ?? 0
    }
    // Суммируем по всем кассам
    let total = 0
    for (const [, v] of Object.entries(openBal)) {
      total += (v?.auto ?? 0)
    }
    return total
  }, [openBal, byCash])

  const manualOpening = useMemo(() => {
    const ob = openBal[0] || openBal['0']
    if (!ob || !ob.is_manual) return null
    return ob.manual ?? null
  }, [openBal])

  const isManualOpening = manualOpening !== null
  const planOpeningAmount = isManualOpening ? manualOpening : autoOpening

  const resetOpeningBalance = useCallback(async () => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount: autoOpening, is_manual: false })
    setReport(prev => {
      if (!prev) return prev
      return { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: null, is_manual: false } } }
    })
  }, [selectedDocId, autoOpening])

  // Остатки по кассам (при byCash)
  const cashOpenings = useMemo(() => {
    if (!byCash) return {}
    const result = {}
    for (const [cashId, ob] of Object.entries(openBal)) {
      result[cashId] = ob?.auto ?? 0
    }
    return result
  }, [openBal, byCash])

  const factBalances = useMemo(() => {
    const result = []
    let prev = autoOpening
    for (const pd of periodDates) {
      const opening = prev
      const move = calcMonthTotal(pd, fact)
      result.push({ opening, move, closing: opening + move })
      prev = opening + move
    }
    return result
  }, [periodDates, fact, autoOpening, calcMonthTotal])

  const planBalances = useMemo(() => {
    const result = []
    let prev = planOpeningAmount
    for (const pd of periodDates) {
      const opening = prev
      const move = calcMonthTotal(pd, plan)
      result.push({ opening, move, closing: opening + move })
      prev = opening + move
    }
    return result
  }, [periodDates, plan, planOpeningAmount, calcMonthTotal])

  // Остатки по отдельным кассам
  const cashBalances = useMemo(() => {
    if (!byCash || cashItems.length === 0) return {}
    const result = {}
    for (const ci of cashItems) {
      const cid = ci.id
      const arr = []
      let prev = cashOpenings[cid] ?? cashOpenings[String(cid)] ?? 0
      for (const pd of periodDates) {
        const opening = prev
        let move = 0
        for (const [key, val] of Object.entries(fact)) {
          const parts = key.split(':')
          if (parts[1] === String(cid) && key.endsWith(':' + pd)) move += val
        }
        arr.push({ opening, move, closing: opening + move })
        prev = opening + move
      }
      result[cid] = arr
    }
    return result
  }, [byCash, cashItems, cashOpenings, periodDates, fact])

  const visibleArticles = useMemo(() => {
    const result = []
    let skipUntilDepth = null
    for (const a of flatArticles) {
      if (skipUntilDepth !== null && a.depth > skipUntilDepth) continue
      skipUntilDepth = null
      result.push(a)
      if (a.hasChildren && !expanded.has(a.id)) skipUntilDepth = a.depth
    }
    return result
  }, [flatArticles, expanded])

  // ── Рендер ──────────────────────────────────────────────────────────────
  const colsPerMonth = showDelta ? 3 : 2

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
        {selectedDoc && (
          <span className={`text-xs px-2 py-1 rounded-full ${selectedDoc.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
            {selectedDoc.status === 'approved' ? 'Утверждён' : 'Черновик'}
          </span>
        )}
        {selectedDoc?.type === 'dds' && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-2">
            <button className={`px-3 py-1.5 text-xs font-medium ${!byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(false)}>Общая сумма</button>
            <button className={`px-3 py-1.5 text-xs font-medium ${byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(true)}>По кассам</button>
          </div>
        )}
        <button
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${showDelta ? 'bg-blue-900 text-white border-blue-900' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}
          onClick={() => setShowDelta(v => !v)}
        >Δ Отклонение</button>
        <div className="ml-auto">
          <button onClick={() => setShowCreateModal(true)} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800">+ Новый бюджет</button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-400">Загрузка отчёта...</div>
      ) : !report ? (
        <div className="text-center py-20 text-gray-400">{documents.length === 0 ? 'Создайте первый бюджет' : 'Выберите документ'}</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" style={{ minWidth: `${280 + periodDates.length * (showDelta ? 210 : 160)}px` }}>
              <thead>
                <tr className="bg-gray-50">
                  <th className="sticky left-0 z-10 bg-gray-50 text-left px-3 py-2 font-semibold text-gray-600 border-b border-gray-200" style={{ minWidth: 240 }}>Статья</th>
                  {periodDates.map(pd => (
                    <th key={pd} colSpan={colsPerMonth} className={`text-center px-1 py-2 font-medium border-b border-l border-gray-200 ${isCurrentMonth(pd) ? 'bg-blue-50 text-blue-800' : 'text-gray-600'}`}>
                      {monthLabel(pd)}{isCurrentMonth(pd) && <span className="ml-1 text-[9px] text-blue-500">▸ тек.</span>}
                    </th>
                  ))}
                </tr>
                <tr className="bg-gray-50/50">
                  <th className="sticky left-0 z-10 bg-gray-50 border-b border-gray-200" />
                  {periodDates.map(renderHeaderSub)}
                </tr>
              </thead>
              <tbody>
                {/* ── Остаток на начало ── */}
                {selectedDoc?.type === 'dds' && (
                  <>
                    <tr className="bg-gray-50 font-semibold border-b border-gray-200">
                      <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">
                        <div className="flex items-center gap-2">
                          01 Остаток на начало
                          {isManualOpening && (
                            <button onClick={resetOpeningBalance}
                              className="text-[10px] font-normal text-amber-600 hover:text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded"
                              title="Сбросить к факту">↻ сброс</button>
                          )}
                        </div>
                      </td>
                      {periodDates.map((pd, i) => {
                        const fb = factBalances[i], pb = planBalances[i]
                        if (!fb || !pb) return <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>
                        return (
                          <Fragment key={pd}>
                            {i === 0 ? (
                              <PlanCell value={planOpeningAmount} onSave={saveOpeningBalance} disabled={selectedDoc.status === 'approved'} />
                            ) : (
                              <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.opening)}</td>
                            )}
                            <td className="text-right px-2 py-1.5 tabular-nums text-gray-700">{fmt(fb.opening)}</td>
                            {showDelta && <DeltaCell fact={fb.opening} plan={pb.opening} />}
                          </Fragment>
                        )
                      })}
                    </tr>
                    {/* Кассы под остатком */}
                    {byCash && cashItems.map(ci => (
                      <tr key={`cash_open_${ci.id}`} className="border-b border-gray-50">
                        <td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-500 text-[11px]" style={{ paddingLeft: 28 }}>
                          └ {ci.name}
                        </td>
                        {periodDates.map((pd, i) => {
                          const cb = cashBalances[ci.id]?.[i]
                          return (
                            <Fragment key={pd}>
                              <td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.opening)}</td>
                              <td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px]">{fmt(cb?.opening)}</td>
                              {showDelta && <td />}
                            </Fragment>
                          )
                        })}
                      </tr>
                    ))}
                  </>
                )}

                {/* ── Строки статей ── */}
                {visibleArticles.map(article => {
                  if (article.isGroup) {
                    return (
                      <tr key={article.id} className="bg-gray-100 border-b border-gray-200">
                        <td className="sticky left-0 z-10 bg-gray-100 px-3 py-2 font-semibold text-gray-700" colSpan={1 + periodDates.length * colsPerMonth}>{article.name}</td>
                      </tr>
                    )
                  }
                  const isParent = article.hasChildren
                  const namePad = 12 + article.depth * 20
                  return (
                    <tr key={article.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${isParent ? 'bg-gray-50/50 font-medium' : ''}`}>
                      <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-gray-700 whitespace-nowrap" style={{ paddingLeft: namePad }}>
                        <div className="flex items-center gap-1">
                          {isParent && <button onClick={() => toggleExpand(article.id)} className="text-gray-400 hover:text-gray-600 text-[10px] w-4">{expanded.has(article.id) ? '▼' : '▶'}</button>}
                          <span className={article.depth === 0 ? 'font-medium' : ''}>
                            {article.depth > 0 && !isParent && <span className="text-gray-300 mr-1">└</span>}
                            {article.name}
                          </span>
                        </div>
                      </td>
                      {periodDates.map(pd => {
                        const factVal = getArticleValue(article.id, pd, fact)
                        const planVal = getArticleValue(article.id, pd, plan)
                        const future = isFutureMonth(pd)
                        const editable = !isParent && selectedDoc?.status !== 'approved'
                        return (
                          <Fragment key={pd}>
                            {editable ? (
                              <PlanCell value={planVal} onSave={(amount) => savePlanCell(article.id, pd, amount)} disabled={false} />
                            ) : (
                              <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(planVal)}</td>
                            )}
                            <td className={`text-right px-2 py-1.5 tabular-nums ${
                              future ? 'text-gray-300' : factVal > 0 ? 'text-gray-700' : factVal < 0 ? 'text-red-600' : 'text-gray-400'
                            }`}>
                              {future ? '—' : fmt(factVal)}
                            </td>
                            {showDelta && <DeltaCell fact={future ? null : factVal} plan={planVal} />}
                          </Fragment>
                        )
                      })}
                    </tr>
                  )
                })}

                {/* ── Движение ── */}
                {selectedDoc?.type === 'dds' && (
                  <tr className="bg-gray-50 font-semibold border-t border-gray-200">
                    <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">02 Движение</td>
                    {periodDates.map((pd, i) => {
                      const fb = factBalances[i], pb = planBalances[i]
                      if (!fb || !pb) return <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>
                      const future = isFutureMonth(pd)
                      return (
                        <Fragment key={pd}>
                          <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.move)}</td>
                          <td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : fb.move >= 0 ? 'text-gray-700' : 'text-red-600'}`}>
                            {future ? '—' : fmt(fb.move)}
                          </td>
                          {showDelta && <DeltaCell fact={future ? null : fb.move} plan={pb.move} />}
                        </Fragment>
                      )
                    })}
                  </tr>
                )}

                {/* ── Остаток на конец ── */}
                {selectedDoc?.type === 'dds' && (
                  <>
                    <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                      <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">03 Остаток на конец</td>
                      {periodDates.map((pd, i) => {
                        const fb = factBalances[i], pb = planBalances[i]
                        if (!fb || !pb) return <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>
                        const future = isFutureMonth(pd)
                        return (
                          <Fragment key={pd}>
                            <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.closing)}</td>
                            <td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : 'text-gray-700'}`}>{future ? '—' : fmt(fb.closing)}</td>
                            {showDelta && <DeltaCell fact={future ? null : fb.closing} plan={pb.closing} />}
                          </Fragment>
                        )
                      })}
                    </tr>
                    {/* Кассы под остатком на конец */}
                    {byCash && cashItems.map(ci => (
                      <tr key={`cash_close_${ci.id}`} className="border-b border-gray-50">
                        <td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-500 text-[11px]" style={{ paddingLeft: 28 }}>└ {ci.name}</td>
                        {periodDates.map((pd, i) => {
                          const cb = cashBalances[ci.id]?.[i]
                          return (
                            <Fragment key={pd}>
                              <td className="text-right px-2 py-1 tabular-nums text-blue-400 text-[11px] border-l border-gray-100">{fmt(cb?.closing)}</td>
                              <td className="text-right px-2 py-1 tabular-nums text-gray-500 text-[11px]">{fmt(cb?.closing)}</td>
                              {showDelta && <td />}
                            </Fragment>
                          )
                        })}
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-gray-100 flex gap-5 text-[11px] text-gray-400">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> План (двойной клик)</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500" /> Факт</span>
            {showDelta && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Δ отклонение</span>}
          </div>
        </div>
      )}

      {showCreateModal && (
        <CreateDocModal projects={projects} onClose={() => setShowCreateModal(false)}
          onCreate={(doc) => { setDocuments(prev => [doc, ...prev]); setSelectedDocId(doc.id); setShowCreateModal(false) }} />
      )}
    </Layout>
  )
}
