import { useEffect, useMemo, useRef, useState } from 'react'
import { getOperations, getBalanceItems } from '../../api/operations'
import {
  getBudgetItems, createBudgetItem, updateBudgetItem, deleteBudgetItem,
} from '../../api/budget'
import { getDocument, postDocument, cancelDocument } from '../../api/documents'
import { getInfo } from '../../api/info'
import OperationForm from '../OperationForm'
import { DocumentForm } from '../../pages/DocumentsPage'

// ── Утилиты форматирования ─────────────────────────────────────────────────
const fmt = (v) => { if (v == null || v === '' || isNaN(v)) return ''; return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) }
const fmtDate = (d) => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('ru-RU') }

// Подпись для копирования: «октябрь 2026» для месячной и «15.10.2026 (пн)» для дневной
const periodLabelShort = (pd, granularity) => {
  if (granularity === 'day') {
    const d = new Date(pd + 'T00:00:00')
    const dow = ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()]
    return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} (${dow})`
  }
  return new Date(pd + 'T00:00:00').toLocaleString('ru-RU', { month: 'short', year: '2-digit' })
}

// Конец периода — для запроса операций факта
const endOfPeriod = (pd, granularity) => {
  if (granularity === 'day') return pd
  const d = new Date(pd + 'T00:00:00'); d.setMonth(d.getMonth() + 1); d.setDate(0)
  return d.toISOString().slice(0, 10)
}

// Плоский список статей для select (с поддержкой групп БДР)
const buildArticleOptions = (articles, sectionFilter = null) => {
  if (!articles) return []
  const flat = []
  const walk = (items, depth = 0) => {
    for (const a of items) {
      flat.push({ id: a.id, name: a.name, depth })
      if (a.children) walk(a.children, depth + 1)
    }
  }
  if (Array.isArray(articles) && articles[0]?.id != null) {
    walk(articles)
  } else if (Array.isArray(articles)) {
    // БДР: массив групп, фильтруем по section если задано
    for (const g of articles) {
      if (sectionFilter && g.group !== sectionFilter) continue
      walk(g.items || [], 0)
    }
  }
  return flat
}

// ══════════════════════════════════════════════════════════════════════════════
// BudgetDrawer — главный компонент
//
// Пропсы:
//   mode          - 'plan' | 'fact' — какой таб открыть
//   articleId     - id статьи
//   articleName   - название статьи (для шапки)
//   periodDate    - дата периода (YYYY-MM-DD)
//   periodLabel   - человекочитаемая подпись периода (для шапки)
//   section       - 'revenue'|'cost'|'expenses' для БДР, null для ДДС/PDC
//   docId         - id бюджетного документа
//   docType       - 'dds' | 'bdr' | 'pdc'
//   articles      - дерево статей из report
//   descendantAllMap - карта потомков для агрегации
//   periodDates   - все периоды из report (для копирования)
//   granularity   - 'day' | 'month' (default 'month')
//   factDrillConfig - report.fact_drill_config: для DDS/PDC = { bi_id, info_field },
//                     для BDR = { П587: {bi_id, info_field}, П588: {...}, П589: {...} }
//   onClose       - закрыть drawer
//   onUpdate      - перезагрузить отчёт после изменений
// ══════════════════════════════════════════════════════════════════════════════
export default function BudgetDrawer({
  mode, articleId, articleName, periodDate, periodLabel, section, docId, docType,
  articles, descendantAllMap, periodDates, granularity = 'month',
  factDrillConfig, onClose, onUpdate,
}) {
  const [tab, setTab] = useState(mode || 'plan')
  useEffect(() => { setTab(mode || 'plan') }, [mode, articleId, periodDate])

  // Подгрузка factOps в FactTab — управляем через ключ перезагрузки
  const [factReloadKey, setFactReloadKey] = useState(0)
  const reloadFact = () => setFactReloadKey(k => k + 1)

  // Состояния для редактирования операций / документов из факта
  const [editOp, setEditOp] = useState(null)
  const [docModal, setDocModal] = useState(null)
  const [docInfoCache, setDocInfoCache] = useState({})
  const [docActionError, setDocActionError] = useState('')
  const [balanceItems, setBalanceItems] = useState([])
  useEffect(() => { getBalanceItems().then(r => setBalanceItems(r.data.data || [])).catch(() => {}) }, [])

  const handleEditSaved = () => { setEditOp(null); reloadFact(); onUpdate?.() }

  const openDocumentModal = async (tableId) => {
    try {
      const r = await getDocument(tableId)
      setDocModal({ doc: r.data.data })
    } catch { /* ignore */ }
  }

  const refreshAfterDocAction = () => {
    setDocModal(null)
    reloadFact()
    onUpdate?.()
  }

  const handleDocPost = async (doc) => {
    setDocActionError('')
    try {
      await postDocument(doc.id)
      const r = await getDocument(doc.id)
      setDocModal({ doc: r.data.data })
      reloadFact(); onUpdate?.()
    } catch (err) {
      setDocActionError(err.response?.data?.message || 'Ошибка проведения')
      setTimeout(() => setDocActionError(''), 4000)
    }
  }

  const handleDocCancel = async (doc) => {
    setDocActionError('')
    try {
      await cancelDocument(doc.id)
      const r = await getDocument(doc.id)
      setDocModal({ doc: r.data.data })
      reloadFact(); onUpdate?.()
    } catch (err) {
      setDocActionError(err.response?.data?.message || 'Ошибка отмены проведения')
      setTimeout(() => setDocActionError(''), 4000)
    }
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
            <button className={`px-3 py-1.5 text-xs font-medium rounded-lg ${tab === 'plan' ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setTab('plan')}>План</button>
            <button className={`px-3 py-1.5 text-xs font-medium rounded-lg ${tab === 'fact' ? 'bg-blue-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`} onClick={() => setTab('fact')}>Факт</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {tab === 'plan' ? (
            <PlanTab
              articleId={articleId} periodDate={periodDate} docId={docId}
              articles={articles} descendantAllMap={descendantAllMap}
              section={section} periodDates={periodDates} granularity={granularity}
              onUpdate={onUpdate}
            />
          ) : (
            <FactTab
              articleId={articleId} periodDate={periodDate} docType={docType}
              descendantAllMap={descendantAllMap}
              factDrillConfig={factDrillConfig}
              granularity={granularity}
              reloadKey={factReloadKey}
              onEditOp={setEditOp} onOpenDoc={openDocumentModal}
            />
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
            onSave={refreshAfterDocAction}
            onCancel={refreshAfterDocAction}
            onPost={handleDocPost}
            onCancelDoc={handleDocCancel}
          />
        </>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Вкладка «План»
// ══════════════════════════════════════════════════════════════════════════════
function PlanTab({ articleId, periodDate, docId, articles, descendantAllMap, onUpdate, section, periodDates, granularity }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newArticle, setNewArticle] = useState(articleId)
  const [newDate, setNewDate] = useState(periodDate)
  const [newContent, setNewContent] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyTargets, setCopyTargets] = useState([])
  const [copyLoading, setCopyLoading] = useState(false)
  const amountRef = useRef(null)

  // Будущие периоды относительно текущего — для копирования
  const futurePeriods = useMemo(() => {
    if (!periodDates) return []
    const idx = periodDates.indexOf(periodDate)
    if (idx < 0) return periodDates.filter(pd => pd > periodDate)
    return periodDates.slice(idx + 1)
  }, [periodDates, periodDate])

  const articleOptions = useMemo(() => buildArticleOptions(articles, section), [articles, section])

  const loadItems = async () => {
    setLoading(true)
    try {
      const allIds = descendantAllMap?.[articleId]
      const ids = allIds && allIds.size > 0 ? [...allIds] : [articleId]
      const params = {
        budget_document_id: docId,
        article_ids: ids.join(','),
        ...(section ? { section } : {}),
      }
      // В дневной гранулярности — точная дата; в месячной — фильтруем клиентом по месяцу
      if (granularity === 'day') {
        params.period_date = periodDate
      } else {
        params.period_date = periodDate
      }
      const res = await getBudgetItems(params)
      let data = res.data.data || []
      // В месячной гранулярности фильтр period_date на бэке whereDate точный по дате,
      // но план в БДР/ДДС хранится 1-м числом — это работает.
      // Для PDC на странице PaymentCalendar в месячном режиме сюда пришли бы записи только 1-го числа,
      // а нам нужен весь месяц. Для PDC всегда передаём granularity='day' из вызывающего кода
      // если открыли с дневной ячейки, или granularity='month' с фильтром по месяцу.
      if (granularity === 'month') {
        const month = periodDate.slice(0, 7)
        data = data.filter(r => r.period_date && r.period_date.startsWith(month))
      }
      setRows(data)
    } catch (e) {
      console.error('PlanTab loadItems error', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadItems() }, [articleId, periodDate, docId, section])
  useEffect(() => { if (adding && amountRef.current) amountRef.current.focus() }, [adding])

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)

  const handleAdd = async () => {
    const amount = parseFloat(newAmount.replace(/\s/g, '').replace(',', '.')) || 0
    if (!amount) return
    setSaving(true)
    try {
      const res = await createBudgetItem({
        budget_document_id: docId,
        article_id: newArticle,
        section: section || null,
        period_date: newDate,
        content: newContent.trim() || null,
        amount,
      })
      setRows(prev => [...prev, res.data.data])
      setNewContent(''); setNewAmount('')
      onUpdate?.()
    } finally { setSaving(false) }
  }

  const handleRowUpdate = async (item, updates) => {
    const res = await updateBudgetItem(item.id, updates)
    setRows(prev => prev.map(r => r.id === item.id ? res.data.data : r))
    onUpdate?.()
  }

  const handleDelete = async (item) => {
    await deleteBudgetItem(item.id)
    setRows(prev => prev.filter(r => r.id !== item.id))
    onUpdate?.()
  }

  const handleCopy = async () => {
    if (copyTargets.length === 0 || rows.length === 0) return
    setCopyLoading(true)
    try {
      for (const targetPd of copyTargets) {
        for (const row of rows) {
          await createBudgetItem({
            budget_document_id: docId,
            article_id: row.article_id,
            section: section || null,
            period_date: targetPd,
            content: row.content || null,
            amount: row.amount,
          })
        }
      }
      setCopying(false)
      setCopyTargets([])
      onUpdate?.()
    } catch (err) {
      console.error('Ошибка копирования:', err)
    } finally {
      setCopyLoading(false)
    }
  }

  const toggleCopyTarget = (pd) => {
    setCopyTargets(prev => prev.includes(pd) ? prev.filter(p => p !== pd) : [...prev, pd])
  }

  const selectAllTargets = () => {
    setCopyTargets(prev => prev.length === futurePeriods.length ? [] : [...futurePeriods])
  }

  if (loading) return <div className="text-center py-12 text-gray-400 text-sm">Загрузка...</div>

  const periodWord = granularity === 'day' ? 'дн.' : 'мес.'

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
          <div className="flex gap-2">
            <input className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
              placeholder="Содержание" value={newContent} onChange={e => setNewContent(e.target.value)} />
            <input ref={amountRef} className="w-28 px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white text-right"
              placeholder="Сумма" value={newAmount} onChange={e => setNewAmount(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false) }} />
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !newAmount} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">{saving ? 'Сохранение...' : 'Добавить'}</button>
            <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">Отмена</button>
          </div>
        </div>
      ) : (
        <button onClick={() => { setNewArticle(articleId); setNewDate(periodDate); setAdding(true) }}
          className="mt-3 w-full px-3 py-2 text-xs text-blue-600 hover:bg-blue-50 rounded-lg border border-dashed border-blue-200">
          + Добавить запись
        </button>
      )}

      {/* Итого */}
      {rows.length > 0 && (
        <div className="flex justify-between items-center mt-3 pt-3 border-t border-gray-100 text-xs">
          <span className="text-gray-500">Итого ({rows.length}):</span>
          <span className="font-semibold text-blue-700 tabular-nums">{fmt(total)}</span>
        </div>
      )}

      {/* Копирование на следующие периоды */}
      {rows.length > 0 && futurePeriods.length > 0 && !copying && (
        <button
          onClick={() => setCopying(true)}
          className="mt-3 w-full px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 rounded-lg border border-gray-200"
        >
          📋 Копировать на следующие периоды...
        </button>
      )}

      {copying && (
        <div className="mt-3 p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase text-gray-500 tracking-wide font-medium">Скопировать в:</span>
            <button onClick={selectAllTargets} className="text-[10px] text-blue-600 hover:text-blue-800">
              {copyTargets.length === futurePeriods.length ? 'Снять все' : 'Выбрать все'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto">
            {futurePeriods.map(pd => {
              const selected = copyTargets.includes(pd)
              return (
                <button
                  key={pd}
                  onClick={() => toggleCopyTarget(pd)}
                  className={`px-2 py-1 text-[10px] rounded border ${
                    selected
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300 hover:text-blue-600'
                  }`}
                >
                  {periodLabelShort(pd, granularity)}
                </button>
              )
            })}
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleCopy}
              disabled={copyTargets.length === 0 || copyLoading}
              className="flex-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {copyLoading ? 'Копирую...' : `Копировать → ${copyTargets.length} ${periodWord}`}
            </button>
            <button
              onClick={() => { setCopying(false); setCopyTargets([]) }}
              className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded-lg"
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Строка плана с inline-редактированием
// ══════════════════════════════════════════════════════════════════════════════
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
            onBlur={() => commit('date', text)}
            onKeyDown={e => { if (e.key === 'Enter') commit('date', text); if (e.key === 'Escape') setEditField(null) }} />
        ) : (
          <span className="text-gray-400 cursor-pointer hover:text-blue-600 whitespace-nowrap"
            onClick={() => { setText(item.period_date || ''); setEditField('date') }} title="Изменить дату">
            {item.period_date ? new Date(item.period_date + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'}
          </span>
        )}
      </div>

      {/* Строка 2: содержание + сумма + удалить */}
      <div className="flex items-center gap-2">
        {editField === 'content' ? (
          <input ref={ref} className="flex-1 px-2 py-1 border border-blue-300 rounded text-xs"
            value={text} onChange={e => setText(e.target.value)}
            onBlur={() => commit('content', text)}
            onKeyDown={e => { if (e.key === 'Enter') commit('content', text); if (e.key === 'Escape') setEditField(null) }} />
        ) : (
          <span className="flex-1 text-xs text-gray-700 cursor-pointer hover:text-blue-600 truncate"
            onClick={() => { setText(item.content || ''); setEditField('content') }} title="Изменить содержание">
            {item.content || <span className="text-gray-300 italic">+ комментарий</span>}
          </span>
        )}
        <div className="flex items-center gap-1">
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

// ══════════════════════════════════════════════════════════════════════════════
// Вкладка «Факт»
// Сама грузит операции из API на основе factDrillConfig, docType и descendantAllMap
// ══════════════════════════════════════════════════════════════════════════════
function FactTab({ articleId, periodDate, docType, descendantAllMap, factDrillConfig, granularity, reloadKey, onEditOp, onOpenDoc }) {
  const [ops, setOps] = useState([])
  const [loading, setLoading] = useState(true)

  // Факторы для агрегации
  const sign = docType === 'bdr' ? -1 : 1
  const targetBiIds = useMemo(() => {
    if (!factDrillConfig) return []
    if (docType === 'bdr') return Object.values(factDrillConfig).map(c => c.bi_id).filter(Boolean)
    return factDrillConfig.bi_id ? [factDrillConfig.bi_id] : []
  }, [factDrillConfig, docType])

  useEffect(() => {
    const load = async () => {
      setLoading(true); setOps([])
      try {
        if (!factDrillConfig) return
        const dateFrom = periodDate
        const dateTo = endOfPeriod(periodDate, granularity)

        const allIds = descendantAllMap?.[articleId]
        const validIds = allIds && allIds.size > 0 ? allIds : new Set([articleId])
        const validIdsStr = new Set([...validIds].map(String))

        let result = []

        if (docType === 'bdr') {
          // БДР: три счёта, каждый со своим info_field
          for (const [, c] of Object.entries(factDrillConfig)) {
            const [resIn, resOut] = await Promise.all([
              getOperations({ in_bi_id: c.bi_id, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
              getOperations({ out_bi_id: c.bi_id, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
            ])
            const infoField = c.info_field
            const inKey = `in_${infoField}`
            const outKey = `out_${infoField}`
            const biOps = [...(resIn.data.data || []), ...(resOut.data.data || [])]
            const filtered = biOps.filter(op => validIdsStr.has(String(op[inKey])) || validIdsStr.has(String(op[outKey])))
            result.push(...filtered)
          }
          result = result.filter((op, i, self) => self.findIndex(o => o.id === op.id) === i)
        } else {
          // ДДС/PDC: один счёт А100, info_2_id
          const biId = factDrillConfig.bi_id
          if (!biId) return
          const [resIn, resOut] = await Promise.all([
            getOperations({ in_bi_id: biId, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
            getOperations({ out_bi_id: biId, date_from: dateFrom, date_to: dateTo, per_page: 500 }),
          ])
          const all = [...(resIn.data.data || []), ...(resOut.data.data || [])]
          const dedup = all.filter((op, i, self) => self.findIndex(o => o.id === op.id) === i)
          result = dedup.filter(op => validIdsStr.has(String(op.in_info_2_id)) || validIdsStr.has(String(op.out_info_2_id)))
        }

        result.sort((a, b) => new Date(b.date) - new Date(a.date))
        setOps(result)
      } catch (e) {
        console.error('FactTab load error', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [articleId, periodDate, docType, granularity, factDrillConfig?.bi_id, reloadKey])

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
                  <div className="flex items-start gap-1.5">
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-mono font-medium">{op.in_bi_code}</span>
                      {op.in_info_1_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.in_info_1_name}</div>}
                      {op.in_info_2_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.in_info_2_name}</div>}
                    </div>
                    <span className="text-[9px] text-gray-300 mt-1 flex-shrink-0">→</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-mono font-medium">{op.out_bi_code}</span>
                      {op.out_info_1_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.out_info_1_name}</div>}
                      {op.out_info_2_name && <div className="text-[10px] text-gray-400 mt-0.5 pl-0.5">↳ {op.out_info_2_name}</div>}
                    </div>
                  </div>
                  {note && <div className="text-[10px] text-gray-400 italic mt-1.5 leading-tight">{note}</div>}
                </td>
                <td className={`px-2 py-2 text-right tabular-nums font-medium align-top whitespace-nowrap ${amt >= 0 ? 'text-gray-700' : 'text-red-600'}`}>{fmt(amt)}</td>
                <td className="px-1 py-2 text-right align-top">
                  {isDoc ? (
                    <button onClick={() => onOpenDoc?.(op.table_id)} title="Открыть документ"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </button>
                  ) : (
                    <button onClick={() => onEditOp?.(op)} title="Редактировать операцию"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                    </button>
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
