import { Fragment, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { getOperations, getBalanceItems } from '../api/operations'
import {
  getBudgetDocuments, createBudgetDocument, updateBudgetDocument,
  getBudgetReport, getBudgetItems, createBudgetItem, updateBudgetItem, deleteBudgetItem, upsertOpeningBalance,
} from '../api/budget'
import { getDocument, postDocument, cancelDocument } from '../api/documents'
import { getInfo } from '../api/info'
import { DocumentForm } from './DocumentsPage'
import OperationForm from '../components/OperationForm'
import Layout from '../components/Layout'

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
function PlanCell({ value, detailCount, disabled, onClick }) {
  const title = detailCount > 1 ? `${detailCount} строк плана` : detailCount === 1 ? '1 строка плана' : 'Нажмите для ввода'
  return <td className={`px-2 py-1.5 text-right text-xs tabular-nums border-l border-gray-100 ${disabled ? 'text-blue-400' : 'text-blue-600 cursor-pointer hover:bg-blue-50'}`} onClick={disabled ? undefined : onClick} title={title}>{fmt(value)}</td>
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

// ── Drawer (план + факт) ────────────────────────────────────────────────────
function BudgetDrawer({ mode, articleName, periodLabel, factOps, factLoading, factSign, targetBiIds, articleId, periodDate, docId, articles, descendantAllMap, onClose, onUpdate, onLoadFact, section }) {
  const [tab, setTab] = useState(mode)
  const factLoaded = useRef(false)

  // Редактирование операции / открытие документа прямо из drawer
  const [editOp, setEditOp] = useState(null)
  const [docModal, setDocModal] = useState(null)
  const [docInfoCache, setDocInfoCache] = useState({})
  const [docActionError, setDocActionError] = useState('')
  const [docActionLoading, setDocActionLoading] = useState(false)
  const [balanceItems, setBalanceItems] = useState([])
  useEffect(() => { getBalanceItems().then(r => setBalanceItems(r.data.data || [])).catch(() => {}) }, [])

  useEffect(() => { setTab(mode); factLoaded.current = false }, [mode, articleId, periodDate])

  const switchTab = (t) => {
    setTab(t)
    if (t === 'fact' && !factLoaded.current) {
      factLoaded.current = true
      onLoadFact(articleId, periodDate)
    }
  }

  useEffect(() => {
    if (mode === 'fact' && !factLoaded.current) {
      factLoaded.current = true
      onLoadFact(articleId, periodDate)
    }
  }, [mode, articleId, periodDate])

  // ── Хэндлеры для операций ──────────────────────────────────────────────────
  const handleEditSaved = () => {
    setEditOp(null)
    onLoadFact(articleId, periodDate) // обновить список операций
    onUpdate()
  }

  const openDocumentModal = async (tableId) => {
    try {
      const r = await getDocument(tableId)
      setDocModal({ doc: r.data.data })
    } catch { /* ignore */ }
  }

  const refreshAfterDocAction = () => {
    setDocModal(null)
    onLoadFact(articleId, periodDate)
    onUpdate()
  }

  const handleDocSaved = () => refreshAfterDocAction()

  const handleDocPost = async (doc) => {
    setDocActionLoading(true); setDocActionError('')
    try {
      await postDocument(doc.id)
      const r = await getDocument(doc.id)
      setDocModal({ doc: r.data.data })
      onLoadFact(articleId, periodDate); onUpdate()
    } catch (err) {
      setDocActionError(err.response?.data?.message || 'Ошибка проведения')
      setTimeout(() => setDocActionError(''), 4000)
    } finally { setDocActionLoading(false) }
  }

  const handleDocCancel = async (doc) => {
    setDocActionLoading(true); setDocActionError('')
    try {
      await cancelDocument(doc.id)
      const r = await getDocument(doc.id)
      setDocModal({ doc: r.data.data })
      onLoadFact(articleId, periodDate); onUpdate()
    } catch (err) {
      setDocActionError(err.response?.data?.message || 'Ошибка отмены проведения')
      setTimeout(() => setDocActionError(''), 4000)
    } finally { setDocActionLoading(false) }
  }

  const loadDocInfo = (type) => {
    getInfo({ type }).then(r => setDocInfoCache(c => ({ ...c, [type]: r.data.data })))
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={editOp || docModal ? undefined : onClose} />
      <div className="fixed top-0 right-0 h-full w-[460px] max-w-full bg-white shadow-2xl z-50 flex flex-col border-l border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-800">{articleName}</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
          </div>
          <div className="text-xs text-gray-400 mb-3">{periodLabel}</div>
          <div className="flex gap-1">
            <button className={`px-3 py-1.5 text-xs font-medium rounded-lg ${tab === 'plan' ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => switchTab('plan')}>План</button>
            <button className={`px-3 py-1.5 text-xs font-medium rounded-lg ${tab === 'fact' ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => switchTab('fact')}>Факт</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {tab === 'plan' ? (
            <PlanTab articleId={articleId} periodDate={periodDate} docId={docId} articles={articles} descendantAllMap={descendantAllMap} onUpdate={onUpdate} section={section} />
          ) : (
            <FactTab ops={factOps} loading={factLoading} sign={factSign} targetBiIds={targetBiIds}
              onEditOp={setEditOp} onOpenDoc={openDocumentModal} />
          )}
        </div>
      </div>

      {/* Редактирование операции */}
      {editOp && (
        <OperationForm
          operation={editOp}
          onSuccess={handleEditSaved}
          onCancel={() => setEditOp(null)}
        />
      )}

      {/* Инлайн-просмотр документа */}
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
    </>
  )
}

// ── Вкладка «План» ──────────────────────────────────────────────────────────
function PlanTab({ articleId, periodDate, docId, articles, descendantAllMap, onUpdate, section }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newArticle, setNewArticle] = useState(articleId)
  const [newDate, setNewDate] = useState(periodDate)
  const [newContent, setNewContent] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const amountRef = useRef(null)

  const articleOptions = useMemo(() => {
    if (!articles) return []
    const flat = []
    const walk = (items, depth = 0) => {
      for (const a of items) { flat.push({ id: a.id, name: a.name, depth }); if (a.children) walk(a.children, depth + 1) }
    }
    if (Array.isArray(articles) && articles[0]?.id != null) walk(articles)
    else if (Array.isArray(articles)) articles.forEach(g => walk(g.items || [], 0))
    return flat
  }, [articles])

  const loadItems = async () => {
    setLoading(true)
    try {
      const allIds = descendantAllMap?.[articleId]
      const ids = allIds && allIds.size > 0 ? [...allIds] : [articleId]
      const res = await getBudgetItems({ budget_document_id: docId, article_ids: ids.join(','), period_date: periodDate, ...(section ? { section } : {}) })
      setRows(res.data.data || [])
    } catch (e) { console.error('loadItems error', e) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadItems() }, [articleId, periodDate, docId])
  useEffect(() => { if (adding && amountRef.current) amountRef.current.focus() }, [adding])

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)

  const handleAdd = async () => {
    const amount = parseFloat(newAmount.replace(/\s/g, '').replace(',', '.')) || 0
    if (!amount) return
    setSaving(true)
    try {
      const res = await createBudgetItem({ budget_document_id: docId, article_id: newArticle, section: section || null, period_date: newDate, content: newContent.trim() || null, amount })
      setRows(prev => [...prev, res.data.data])
      setNewContent(''); setNewAmount('')
      onUpdate()
    } finally { setSaving(false) }
  }

  const handleRowUpdate = async (item, updates) => {
    const res = await updateBudgetItem(item.id, updates)
    setRows(prev => prev.map(r => r.id === item.id ? res.data.data : r))
    onUpdate()
  }

  const handleDelete = async (item) => {
    await deleteBudgetItem(item.id)
    setRows(prev => prev.filter(r => r.id !== item.id))
    onUpdate()
  }

  if (loading) return <div className="text-center py-12 text-gray-400 text-sm">Загрузка...</div>

  return (
    <div className="px-4 py-4">
      {rows.length === 0 && !adding && <div className="text-center py-8 text-gray-400 text-sm">Нет строк плана</div>}
      <div className="space-y-2">
        {rows.map(item => (
          <DrawerRow key={item.id} item={item} articleOptions={articleOptions} onUpdate={handleRowUpdate} onDelete={handleDelete} />
        ))}
      </div>

      {/* Форма добавления */}
      {adding ? (
        <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100 space-y-2">
          {/* Строка 1: статья + дата */}
          <div className="flex gap-2">
            <select className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
              value={newArticle} onChange={e => setNewArticle(Number(e.target.value))}>
              {articleOptions.map(a => (
                <option key={a.id} value={a.id}>{'\u00A0\u00A0'.repeat(a.depth)}{a.name}</option>
              ))}
            </select>
            <input type="date" className="w-32 px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
              value={newDate} onChange={e => setNewDate(e.target.value)} />
          </div>
          {/* Строка 2: содержание + сумма */}
          <div className="flex gap-2">
            <input className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
              placeholder="Содержание" value={newContent} onChange={e => setNewContent(e.target.value)} />
            <input ref={amountRef} className="w-28 px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white text-right"
              placeholder="Сумма" value={newAmount} onChange={e => setNewAmount(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false) }} />
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">{saving ? '...' : 'Добавить'}</button>
            <button onClick={() => { setAdding(false); setNewContent(''); setNewAmount('') }} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg">Отмена</button>
          </div>
        </div>
      ) : (
        <button onClick={() => { setAdding(true); setNewArticle(articleId); setNewDate(periodDate) }} className="mt-3 w-full py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg border border-dashed border-blue-200">+ Добавить строку</button>
      )}

      {rows.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100 flex justify-between items-center">
          <span className="text-xs text-gray-500">Итого ({rows.length})</span>
          <span className="text-sm font-semibold text-blue-700 tabular-nums">{fmt(total)}</span>
        </div>
      )}
    </div>
  )
}

function DrawerRow({ item, articleOptions, onUpdate, onDelete }) {
  const [editField, setEditField] = useState(null) // 'content' | 'amount' | 'article' | 'date'
  const [text, setText] = useState('')
  const ref = useRef(null)

  useEffect(() => { if (editField && ref.current) ref.current.focus() }, [editField])

  const commit = (field, value) => {
    setEditField(null)
    if (field === 'amount') {
      const n = parseFloat(String(value).replace(/\s/g, '').replace(',', '.')) || 0
      if (n !== item.amount) onUpdate(item, { amount: n })
    } else if (field === 'content') {
      if (value !== item.content) onUpdate(item, { content: value })
    } else if (field === 'article') {
      const id = Number(value)
      if (id !== item.article_id) onUpdate(item, { article_id: id })
    } else if (field === 'date') {
      if (value !== item.period_date) onUpdate(item, { period_date: value })
    }
  }

  return (
    <div className="group p-3 bg-white rounded-lg border border-gray-100 hover:border-gray-200 transition-colors space-y-1.5">
      {/* Строка 1: статья + дата */}
      <div className="flex items-center gap-2 text-[11px]">
        {editField === 'article' ? (
          <select ref={ref} className="flex-1 px-2 py-1 border border-blue-300 rounded text-[11px]"
            value={item.article_id} onChange={e => commit('article', e.target.value)} onBlur={() => setEditField(null)}>
            {articleOptions.map(a => <option key={a.id} value={a.id}>{'\u00A0\u00A0'.repeat(a.depth)}{a.name}</option>)}
          </select>
        ) : (
          <span className="flex-1 text-gray-500 cursor-pointer hover:text-blue-600 truncate"
            onClick={() => setEditField('article')} title="Изменить статью">
            {item.article_name}
          </span>
        )}
        {editField === 'date' ? (
          <input ref={ref} type="date" className="px-2 py-1 border border-blue-300 rounded text-[11px]"
            value={text} onChange={e => setText(e.target.value)}
            onBlur={() => commit('date', text)} onKeyDown={e => { if (e.key === 'Enter') commit('date', text) }} />
        ) : (
          <span className="text-gray-400 cursor-pointer hover:text-blue-600"
            onClick={() => { setText(item.period_date || ''); setEditField('date') }}>
            {item.period_date ? new Date(item.period_date + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—'}
          </span>
        )}
      </div>
      {/* Строка 2: содержание + сумма */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {editField === 'content' ? (
            <input ref={ref} className="w-full px-2 py-1 border border-blue-300 rounded text-sm"
              value={text} onChange={e => setText(e.target.value)}
              onBlur={() => commit('content', text)} onKeyDown={e => { if (e.key === 'Enter') commit('content', text); if (e.key === 'Escape') setEditField(null) }} />
          ) : (
            <div className="text-sm text-gray-700 cursor-pointer hover:text-blue-600"
              onClick={() => { setText(item.content || ''); setEditField('content') }}>
              {item.content || <span className="text-gray-300 italic">без описания</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {editField === 'amount' ? (
            <input ref={ref} className="w-24 px-2 py-1 border border-blue-300 rounded text-sm text-right"
              value={text} onChange={e => setText(e.target.value)}
              onBlur={() => commit('amount', text)} onKeyDown={e => { if (e.key === 'Enter') commit('amount', text); if (e.key === 'Escape') setEditField(null) }} />
          ) : (
            <div className="text-sm font-medium text-blue-600 tabular-nums cursor-pointer hover:text-blue-800"
              onClick={() => { setText(String(Math.round(item.amount))); setEditField('amount') }}>
              {fmt(item.amount)}
            </div>
          )}
          <button onClick={() => onDelete(item)} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity text-sm">&times;</button>
        </div>
      </div>
    </div>
  )
}

// ── Вкладка «Факт» ──────────────────────────────────────────────────────────
// targetBiIds — id счетов по которым фильтровали (для определения стороны)
// sign — множитель: для БДР = -1 (дебет П = расход, кредит П = возврат)
// onEditOp   — callback(op) для ручных операций
// onOpenDoc  — callback(tableId) для операций из документов
function FactTab({ ops, loading, sign = 1, targetBiIds = [], onEditOp, onOpenDoc }) {
  if (loading) return <div className="text-center py-12 text-gray-400 text-sm">Загрузка операций...</div>
  if (!ops || ops.length === 0) return <div className="text-center py-12 text-gray-400 text-sm">Операций не найдено</div>

  const biIdSet = new Set(targetBiIds.map(String))

  const getAmount = (op) => {
    const raw = parseFloat(op.amount)
    if (biIdSet.size === 0) return raw * sign
    const isDebit = biIdSet.has(String(op.in_bi_id))
    return isDebit ? raw * sign : raw * (-sign)
  }

  const total = ops.reduce((s, op) => s + getAmount(op), 0)
  return (
    <div className="px-2 py-2">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white">
          <tr className="text-[10px] text-gray-400 uppercase">
            <th className="text-left px-2 py-2 whitespace-nowrap">Дата</th>
            <th className="text-left px-2 py-2">Счета / Аналитика / Содержание</th>
            <th className="text-right px-2 py-2 whitespace-nowrap">Сумма</th>
            <th className="w-7" />
          </tr>
        </thead>
        <tbody>
          {ops.map(op => {
            const amt = getAmount(op)
            const isDoc = op.table_name === 'documents' && op.table_id
            const note = op.note || op.content

            return (
              <tr key={op.id} className="border-b border-gray-50 hover:bg-gray-50 group">
                <td className="px-2 py-2 text-gray-500 whitespace-nowrap align-top">{fmtDate(op.date)}</td>
                <td className="px-2 py-2 align-top">
                  {/* Дебет и кредит в два столбца */}
                  <div className="flex items-start gap-1.5">
                    {/* Дебет (in) */}
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.in_bi_code}</span>
                      {op.in_info_1_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.in_info_1_name}</div>}
                      {op.in_info_2_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.in_info_2_name}</div>}
                    </div>
                    <span className="text-[9px] text-gray-300 mt-1 flex-shrink-0">→</span>
                    {/* Кредит (out) */}
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-mono font-medium">{op.out_bi_code}</span>
                      {op.out_info_1_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.out_info_1_name}</div>}
                      {op.out_info_2_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.out_info_2_name}</div>}
                    </div>
                  </div>
                  {/* Содержание */}
                  {note && (
                    <div className="text-[10px] text-gray-400 italic mt-1.5 leading-tight">{note}</div>
                  )}
                </td>
                <td className={`px-2 py-2 text-right tabular-nums font-medium align-top whitespace-nowrap ${amt >= 0 ? 'text-gray-700' : 'text-red-600'}`}>{fmt(amt)}</td>
                <td className="px-1 py-2 text-right align-top">
                  {isDoc ? (
                    <button
                      onClick={() => onOpenDoc?.(op.table_id)}
                      title="Открыть документ"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50"
                    ><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></button>
                  ) : (
                    <button
                      onClick={() => onEditOp?.(op)}
                      title="Редактировать операцию"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50"
                    ><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-200 bg-gray-50">
            <td colSpan={2} className="px-2 py-2 text-[10px] font-semibold text-gray-600">Итого ({ops.length})</td>
            <td className="px-2 py-2 text-right text-xs font-bold text-gray-800 tabular-nums">{fmt(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
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
  const [drawer, setDrawer] = useState(null)
  const [factOps, setFactOps] = useState([]); const [factLoading, setFactLoading] = useState(false)
  const [editDoc, setEditDoc] = useState(null) // { name, period_from, period_to }

  useEffect(() => { api.get('/me').catch(() => navigate('/login')); api.get('/projects').then(r => setProjects(r.data.data || r.data)); loadDocuments() }, [])
  const loadDocuments = async () => { const r = await getBudgetDocuments(); const d = r.data.data; setDocuments(d); if (d.length > 0 && !selectedDocId) setSelectedDocId(d[0].id) }
  useEffect(() => { if (selectedDocId) loadReport() }, [selectedDocId, byCash])

  const loadReport = async (keepState = false) => {
    if (!keepState) setLoading(true)
    try {
      const r = await getBudgetReport(selectedDocId, { by_cash: byCash ? 1 : 0 })
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
    setFactOps([]); setFactLoading(false)
  }

  const loadFactOps = async (articleId, periodDate) => {
    setFactLoading(true); setFactOps([])
    try {
      const cfg = report?.fact_drill_config
      if (!cfg) return
      const dateFrom = periodDate
      const dateTo = endOfMonth(periodDate)

      // Все потомки включая промежуточные (операция может быть на parent-узле)
      const allIds = descendantAllMap[articleId]
      const validIds = new Set(allIds && allIds.size > 0 ? allIds : [articleId])
      const validIdsStr = new Set([...validIds].map(String))

      let ops = []

      if (selectedDoc?.type === 'dds') {
        const biId = cfg.bi_id
        const [resIn, resOut] = await Promise.all([
          getOperations({ in_bi_id: biId, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
          getOperations({ out_bi_id: biId, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
        ])
        const all = [...(resIn.data.data || []), ...(resOut.data.data || [])]
        ops = all.filter((op, i, self) => self.findIndex(o => o.id === op.id) === i)
        ops = ops.filter(op => validIdsStr.has(String(op.in_info_2_id)) || validIdsStr.has(String(op.out_info_2_id)))
      } else {
        const allOps = []
        for (const [code, c] of Object.entries(cfg)) {
          const [resIn, resOut] = await Promise.all([
            getOperations({ in_bi_id: c.bi_id, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
            getOperations({ out_bi_id: c.bi_id, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
          ])
          const infoField = c.info_field
          const inKey = `in_${infoField}`
          const outKey = `out_${infoField}`
          const biOps = [...(resIn.data.data || []), ...(resOut.data.data || [])]
          const filtered = biOps.filter(op => validIdsStr.has(String(op[inKey])) || validIdsStr.has(String(op[outKey])))
          allOps.push(...filtered)
        }
        ops = allOps.filter((op, i, self) => self.findIndex(o => o.id === op.id) === i)
      }
      ops.sort((a, b) => new Date(b.date) - new Date(a.date))
      setFactOps(ops)
    } finally { setFactLoading(false) }
  }

  const saveOpeningBalance = useCallback(async (amount) => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount, is_manual: true })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: amount, is_manual: true } } } : prev)
  }, [selectedDocId])

  const toggleExpand = (id) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const openEditDoc = () => {
    if (!selectedDoc) return
    setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0, 10), period_to: selectedDoc.period_to?.slice(0, 10) })
  }

  const saveDocSettings = async () => {
    if (!editDoc || !selectedDocId) return
    await updateBudgetDocument(selectedDocId, editDoc)
    setDocuments(prev => prev.map(d => d.id === selectedDocId ? { ...d, ...editDoc } : d))
    setEditDoc(null)
    loadReport()
  }

  const selectedDoc = documents.find(d => d.id === selectedDocId)
  const periodDates = report?.period_dates || []; const plan = report?.plan || {}; const fact = report?.fact || {}
  const planDetails = report?.plan_details || {}; const openBal = report?.opening_balances || {}; const cashItems = report?.cash_items || []
  const colsPerMonth = showDelta ? 3 : 2

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

  const autoOpening = useMemo(() => { if (!byCash) { const ob = openBal[0] || openBal['0']; return ob?.auto ?? 0 }; let t = 0; for (const [, v] of Object.entries(openBal)) t += (v?.auto ?? 0); return t }, [openBal, byCash])
  const manualOpening = useMemo(() => { const ob = openBal[0] || openBal['0']; return ob?.is_manual ? (ob.manual ?? null) : null }, [openBal])
  const isManualOpening = manualOpening !== null; const planOpeningAmount = isManualOpening ? manualOpening : autoOpening

  const resetOpeningBalance = useCallback(async () => {
    await upsertOpeningBalance({ budget_document_id: selectedDocId, cash_id: null, amount: autoOpening, is_manual: false })
    setReport(prev => prev ? { ...prev, opening_balances: { ...prev.opening_balances, 0: { ...prev.opening_balances?.[0], manual: null, is_manual: false } } } : prev)
  }, [selectedDocId, autoOpening])

  const factBalances = useMemo(() => { const r = []; let p = autoOpening; for (const pd of periodDates) { const o = p, m = calcMonthTotal(pd, fact); r.push({ opening: o, move: m, closing: o + m }); p = o + m }; return r }, [periodDates, fact, autoOpening, calcMonthTotal])
  const planBalances = useMemo(() => { const r = []; let p = planOpeningAmount; for (const pd of periodDates) { const o = p, m = calcMonthTotal(pd, plan); r.push({ opening: o, move: m, closing: o + m }); p = o + m }; return r }, [periodDates, plan, planOpeningAmount, calcMonthTotal])
  const cashOpenings = useMemo(() => { if (!byCash) return {}; const r = {}; for (const [c, ob] of Object.entries(openBal)) r[c] = ob?.auto ?? 0; return r }, [openBal, byCash])
  const cashBalances = useMemo(() => { if (!byCash || !cashItems.length) return {}; const r = {}; for (const ci of cashItems) { const a = []; let p = cashOpenings[ci.id] ?? cashOpenings[String(ci.id)] ?? 0; for (const pd of periodDates) { const o = p; let m = 0; for (const [k, v] of Object.entries(fact)) if (k.split(':')[1] === String(ci.id) && k.endsWith(':' + pd)) m += v; a.push({ opening: o, move: m, closing: o + m }); p = o + m }; r[ci.id] = a }; return r }, [byCash, cashItems, cashOpenings, periodDates, fact])

  const visibleArticles = useMemo(() => { const r = []; let skip = null; for (const a of flatArticles) { if (skip !== null && a.depth > skip) continue; skip = null; r.push(a); if (a.hasChildren && !expanded.has(a.id)) skip = a.depth }; return r }, [flatArticles, expanded])

  const renderHeaderSub = (pd) => (
    <Fragment key={pd}>
      <th className="text-center px-1 py-1 text-[10px] text-blue-500 font-medium border-b border-l border-gray-200" style={{ width: 80 }}>План</th>
      <th className="text-center px-1 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-200" style={{ width: 80 }}>Факт</th>
      {showDelta && <th className="text-center px-1 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-200" style={{ width: 50 }}>Δ</th>}
    </Fragment>
  )

  // ── Строка-итог БДР (прибыль) ─────────────────────────────────────────────
  const renderProfitRow = (label, calcFn, borderCls = 'border-t border-gray-200') => (
    <tr className={`bg-gray-50 font-semibold ${borderCls}`}>
      <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-700">{label}</td>
      {periodDates.map(pd => {
        const { factVal, planVal } = calcFn(pd)
        const future = isFutureMonth(pd)
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
        <select className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white" value={selectedDocId || ''} onChange={e => setSelectedDocId(Number(e.target.value))}>
          {documents.length === 0 && <option value="">Нет документов</option>}
          {documents.map(d => <option key={d.id} value={d.id}>{d.name} ({d.type.toUpperCase()})</option>)}
        </select>
        {selectedDoc && <span className={`text-xs px-2 py-1 rounded-full ${selectedDoc.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{selectedDoc.status === 'approved' ? 'Утверждён' : 'Черновик'}</span>}
        {selectedDoc && <button onClick={openEditDoc} className="text-gray-400 hover:text-gray-600 text-sm" title="Настройки бюджета">⚙</button>}
        {selectedDoc?.type === 'dds' && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden ml-2">
            <button className={`px-3 py-1.5 text-xs font-medium ${!byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(false)}>Общая сумма</button>
            <button className={`px-3 py-1.5 text-xs font-medium ${byCash ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`} onClick={() => setByCash(true)}>По кассам</button>
          </div>
        )}
        <button className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${showDelta ? 'bg-blue-900 text-white border-blue-900' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`} onClick={() => setShowDelta(v => !v)}>Δ Отклонение</button>
        <div className="ml-auto"><button onClick={() => setShowCreateModal(true)} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800">+ Новый бюджет</button></div>
      </div>

      {/* Панель редактирования документа */}
      {editDoc && (
        <div className="mb-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="grid grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Название</label>
              <input className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white" value={editDoc.name} onChange={e => setEditDoc(prev => ({ ...prev, name: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Период с</label>
              <input type="date" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white" value={editDoc.period_from} onChange={e => setEditDoc(prev => ({ ...prev, period_from: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Период по</label>
              <input type="date" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white" value={editDoc.period_to} onChange={e => setEditDoc(prev => ({ ...prev, period_to: e.target.value }))} />
            </div>
            <div className="flex gap-2">
              <button onClick={saveDocSettings} className="px-4 py-2 text-sm bg-blue-900 text-white rounded-lg hover:bg-blue-800">Сохранить</button>
              <button onClick={() => setEditDoc(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Отмена</button>
            </div>
          </div>
        </div>
      )}

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
                {/* ДДС: Остаток на начало */}
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
                          <td className="sticky left-0 z-10 bg-gray-100 px-3 py-2 font-semibold text-gray-700">{article.name}</td>
                          {selectedDoc?.type === 'bdr' && totals ? periodDates.map(pd => {
                            const g = totals[pd] || { fact: 0, plan: 0 }
                            const future = isFutureMonth(pd)
                            return (
                              <Fragment key={pd}>
                                <td className="text-right px-2 py-2 tabular-nums text-blue-700 font-semibold border-l border-gray-200">{fmt(g.plan)}</td>
                                <td className={`text-right px-2 py-2 tabular-nums font-semibold ${future ? 'text-gray-300' : g.fact >= 0 ? 'text-gray-800' : 'text-red-600'}`}>{future ? '—' : fmt(g.fact)}</td>
                                {showDelta && <DeltaCell fact={future ? null : g.fact} plan={g.plan} />}
                              </Fragment>
                            )
                          }) : periodDates.map(pd => <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>)}
                        </tr>
                      </Fragment>
                    )
                  }
                  const isParent = article.hasChildren
                  return (
                    <tr key={article.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${isParent ? 'bg-gray-50/50 font-medium' : ''}`}>
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
                        </div>
                      </td>
                      {periodDates.map(pd => {
                        const sec = article.section || null
                        const factVal = getArticleValue(article.id, pd, fact, sec)
                        const planVal = getArticleValue(article.id, pd, plan, sec)
                        const future = isFutureMonth(pd)
                        const editable = selectedDoc?.status !== 'approved'
                        const key = sec ? `${sec}:${article.id}:0:${pd}` : `${article.id}:0:${pd}`
                        const count = planDetails[key]?.length || 0
                        return (
                          <Fragment key={pd}>
                            {editable ? <PlanCell value={planVal} detailCount={count} disabled={false} onClick={() => openDrawer(article.id, article.name, pd, 'plan', sec)} />
                              : <td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(planVal)}</td>}
                            <FactCell value={factVal} future={future} onClick={factVal && !future ? () => openDrawer(article.id, article.name, pd, 'fact', sec) : null} />
                            {showDelta && <DeltaCell fact={future ? null : factVal} plan={planVal} />}
                          </Fragment>
                        )
                      })}
                    </tr>
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
                    {periodDates.map((pd, i) => { const fb = factBalances[i], pb = planBalances[i]; if (!fb || !pb) return <Fragment key={pd}><td /><td />{showDelta && <td />}</Fragment>; const future = isFutureMonth(pd)
                      return <Fragment key={pd}><td className="text-right px-2 py-1.5 tabular-nums text-blue-600 border-l border-gray-100">{fmt(pb.move)}</td><td className={`text-right px-2 py-1.5 tabular-nums ${future ? 'text-gray-300' : fb.move >= 0 ? 'text-gray-700' : 'text-red-600'}`}>{future ? '—' : fmt(fb.move)}</td>{showDelta && <DeltaCell fact={future ? null : fb.move} plan={pb.move} />}</Fragment>
                    })}
                  </tr>
                )}

                {/* ДДС: Остаток на конец */}
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
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500" /> Факт (клик для расшифровки)</span>
            {showDelta && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Δ отклонение</span>}
          </div>
        </div>
      )}

      {drawer && (() => {
        const cfg = report?.fact_drill_config || {}
        const biIds = selectedDoc?.type === 'dds' ? (cfg.bi_id ? [cfg.bi_id] : []) : Object.values(cfg).map(c => c.bi_id)
        return <BudgetDrawer mode={drawer.mode} articleName={drawer.articleName} periodLabel={drawer.periodLabel}
          factOps={factOps} factLoading={factLoading} factSign={selectedDoc?.type === 'bdr' ? -1 : 1} targetBiIds={biIds}
          articleId={drawer.articleId} periodDate={drawer.periodDate} docId={selectedDocId}
          articles={report?.articles} descendantAllMap={descendantAllMap}
          onClose={() => setDrawer(null)} onUpdate={() => loadReport(true)} onLoadFact={loadFactOps}
          section={drawer.section} />
      })()}

      {showCreateModal && <CreateDocModal projects={projects} onClose={() => setShowCreateModal(false)} onCreate={(doc) => { setDocuments(prev => [doc, ...prev]); setSelectedDocId(doc.id); setShowCreateModal(false) }} />}
    </Layout>
  )
}
