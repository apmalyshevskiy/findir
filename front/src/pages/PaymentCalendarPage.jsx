import { Fragment, useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  getBudgetDocuments, createBudgetDocument, updateBudgetDocument,
  getBudgetReport, getBudgetItems, createBudgetItem, deleteBudgetItem, upsertOpeningBalance,
} from '../api/budget'
import Layout from '../components/Layout'
import BudgetDrawer from '../components/budget/BudgetDrawer'
import { AlertTriangle, Plus, RotateCcw, Settings, X } from 'lucide-react'
import {
  apiError, confirm, toast, Badge, Button, ErrorState, Field, IconButton, Input, Modal, PageHeader, Segmented, Select,
} from '../components/ui'
import { SkeletonRows } from '../components/Busy'
import usePersistedState from '../hooks/usePersistedState'

// ── Утилиты ────────────────────────────────────────────────────────────────
const fmt = (v) => { if (v == null || v === '' || isNaN(v)) return ''; return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) }
/**
 * Сумма в ячейке статьи: ноль — пусто. За месяц по дням это сотни нулей, и
 * среди них не видно тех дней, где что-то запланировано. В итоговых строках
 * ноль остаётся: остаток «0» — это значимая цифра, а не отсутствие данных.
 */
const fmtCell = (v) => (v ? fmt(v) : '')
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
    } catch (err) {
      // Раньше отказ сервера пропадал: кнопка переставала крутиться, окно
      // оставалось открытым, и было непонятно, создан календарь или нет
      toast.error(apiError(err, 'Не удалось создать календарь'))
    } finally { setSaving(false) }
  }

  // Клик мимо окна не закрывает его: промахнуться мимо поля и потерять
  // набранное хуже, чем лишний раз нажать Esc
  return (
    <Modal onClose={onClose} title="Новый платёжный календарь" closeOnBackdrop={false}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" loading={saving} disabled={!name.trim()} onClick={handleSubmit}>Создать</Button>
      </>}>
      <div className="space-y-4">
        <Field label="Название">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Календарь на декабрь 2026" data-autofocus="" />
        </Field>
        <Field label="Проект">
          <Select value={projectId} onChange={e => setProjectId(e.target.value)}>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Период с"><Input type="date" value={periodFrom} onChange={e => setPeriodFrom(e.target.value)} /></Field>
          <Field label="Период по"><Input type="date" value={periodTo} onChange={e => setPeriodTo(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-gray-500">
          Удобный горизонт — от двух до восьми недель. Несколько месяцев лучше смотреть в режиме «Месяц».
        </p>
      </div>
    </Modal>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
export default function PaymentCalendarPage() {
  const navigate = useNavigate()
  const [documents, setDocuments] = useState([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  // Отчёт не загрузился — отдельно от «пусто»: раньше ошибка тонула в
  // try/finally, и на экране оставался прошлый календарь или пустота
  const [loadError, setLoadError] = useState(false)

  // Настройки экрана держатся между заходами — так же, как в бюджете:
  // календарь открывают каждый день, и каждый раз выставлять вид заново незачем
  const [selectedDocId, setSelectedDocId] = usePersistedState('pdc:docId', null)
  const [byCash, setByCash] = usePersistedState('pdc:byCash', false)
  const [granularity, setGranularity] = usePersistedState('pdc:granularity', 'day') // 'day' | 'month'
  const [viewMode, setViewMode] = usePersistedState('pdc:viewMode', 'plan_fact') // 'plan' | 'fact' | 'plan_fact'
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
    // Запомненный календарь мог уйти в архив или быть удалён — тогда первый
    // из списка, а не пустой экран
    if (d.length > 0 && !d.some(x => x.id === selectedDocId)) setSelectedDocId(d[0].id)
  }

  useEffect(() => { if (selectedDocId) loadReport() }, [selectedDocId, byCash, granularity, displayFrom])

  const loadReport = async (keepState = false) => {
    if (!keepState) setLoading(true)
    setLoadError(false)
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
    } catch (err) {
      // Обновление после правки не удалось — календарь на экране остаётся,
      // говорим уведомлением; не удалась сама загрузка — показываем это
      if (keepState) toast.error(apiError(err, 'Не удалось обновить календарь'))
      else { setReport(null); setLoadError(true) }
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
  // Подпись периода в вопросах и уведомлениях: день — числом, месяц — словом
  const periodName = (pd) => granularity === 'day'
    ? new Date(pd + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
    : monthLabel(pd)

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
      const stale = existing.data.data || []

      // Вставка заменяет период целиком. Раньше это делалось молча по
      // правому клику: промахнулся ячейкой — и запланированные платежи дня
      // исчезли без возможности вернуть
      if (stale.length > 0) {
        const sum = stale.reduce((t, r) => t + Number(r.amount || 0), 0)
        const ok = await confirm({
          title: `Заменить план на ${periodName(targetPeriodDate)}?`,
          text: `По статье «${clipboard.articleName}» там уже ${stale.length} ${stale.length === 1 ? 'строка' : 'строк(и)'} на ${fmt(sum)} ₽. ` +
                `Они будут удалены и заменены планом на ${periodName(clipboard.periodDate)}.`,
          confirmLabel: 'Заменить', danger: true,
        })
        if (!ok) return
      }

      for (const row of stale) {
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
      toast.success(`План вставлен на ${periodName(targetPeriodDate)}`)
    } catch (err) {
      console.error('Ошибка вставки:', err)
      toast.error(apiError(err, 'Не удалось вставить план'))
      loadReport(true)
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

  /**
   * Дни, по которым факт в отчёте вообще есть.
   *
   * Ключ факта кончается датой и появляется только там, где были обороты по
   * деньгам, — значит набор дат из ключей и отвечает на вопрос «есть ли факт
   * за этот день».
   */
  const factDays = useMemo(
    () => new Set(Object.keys(fact).map(k => k.slice(k.lastIndexOf(':') + 1))), [fact])

  /**
   * Будущий день, по которому фактов нет: вместо суммы показываем «—».
   *
   * Ноль в таком дне читался бы как «ничего не заплатили», хотя день просто не
   * наступил. Но если движения по деньгам в будущем дне есть — платежи
   * провели вперёд, или это демо-база с годом истории, — факт показываем.
   *
   * Строки «Движение» и «Остаток на конец» это не меняет: они остаются
   * прогнозом по плану, иначе один проведённый вперёд платёж подменял бы
   * фактом весь прогноз дня, а с ним и всю дальнейшую кривую остатка.
   */
  const isBlankFuture = (pd) => isFuture(pd) && !factDays.has(pd)

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
    if (newStatus === 'archived' && !await confirm({
      title: 'Отправить календарь в архив?',
      text: 'Он пропадёт из списка. Данные останутся — вернуть можно из архива.',
      confirmLabel: 'В архив',
    })) return
    try {
      await updateBudgetDocument(selectedDocId, { status: newStatus })
    } catch (err) {
      toast.error(apiError(err, 'Не удалось сменить статус'))
      return
    }
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
      <PageHeader title="Платёжный календарь"
        subtitle={selectedDoc
          ? `${new Date(selectedDoc.period_from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })} — ${new Date(selectedDoc.period_to).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })} · ${periodDates.length} ${granularity === 'day' ? 'дн.' : 'мес.'}`
          : 'Что придёт и что платить по дням — и хватит ли денег'}
        actions={<Button variant="primary" icon={Plus} onClick={() => setShowCreateModal(true)}>Новый календарь</Button>} />

      <div className="flex items-center gap-x-2 gap-y-2 mb-4 flex-wrap">
        {/* Какой календарь открыт. Статус — меткой рядом, а не цветом самого
            списка: так же, как в бюджете */}
        <select
          className="h-9 pl-3 pr-8 max-w-[24rem] border border-gray-200 rounded-lg text-sm font-medium text-gray-900 bg-white shadow-sm hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500"
          value={selectedDocId || ''}
          onChange={e => setSelectedDocId(parseInt(e.target.value) || null)}
        >
          {documents.length === 0 && <option value="">Нет календарей</option>}
          {documents.map(d => (
            <option key={d.id} value={d.id}>
              {d.name}{d.status === 'draft' ? ' · черновик' : ''}
            </option>
          ))}
        </select>
        {selectedDoc && (
          <Badge tone={selectedDoc.status === 'approved' ? 'green' : selectedDoc.status === 'archived' ? 'gray' : 'amber'}>
            {selectedDoc.status === 'approved' ? 'Утверждён' : selectedDoc.status === 'archived' ? 'Архив' : 'Черновик'}
          </Badge>
        )}

        {/* Настройки календаря */}
        {selectedDoc && (
          <div className="relative">
            <IconButton icon={Settings} label="Настройки календаря" variant="solid" size="lg"
              className={showSettingsPopup ? 'bg-gray-100' : ''}
              onClick={() => setShowSettingsPopup(v => !v)} />
            {showSettingsPopup && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => { setShowSettingsPopup(false); setEditDoc(null) }} />
                <div className="absolute top-full left-0 mt-1.5 w-80 bg-white border border-gray-200 rounded-xl shadow-pop z-40 p-4 space-y-4 animate-pop-in">
                  <div>
                    <div className="text-2xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Статус</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedDoc.status === 'draft' && (
                        <Button size="sm" variant="primary" onClick={() => { changeStatus('approved'); setShowSettingsPopup(false) }}>Утвердить</Button>
                      )}
                      {selectedDoc.status === 'approved' && (
                        <Button size="sm" onClick={() => { changeStatus('draft'); setShowSettingsPopup(false) }}>Вернуть в черновик</Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => { setShowSettingsPopup(false); changeStatus('archived') }}>В архив</Button>
                    </div>
                  </div>
                  <div className="border-t border-gray-100 pt-4 space-y-3">
                    <div className="text-2xs font-semibold uppercase tracking-wider text-gray-500">Параметры</div>
                    <Field label="Название">
                      <Input size="sm"
                        value={editDoc?.name ?? selectedDoc.name}
                        onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), name: e.target.value }))}
                        onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Период с">
                        <Input size="sm" type="date"
                          value={editDoc?.period_from ?? selectedDoc.period_from?.slice(0,10)}
                          onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), period_from: e.target.value }))}
                          onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                        />
                      </Field>
                      <Field label="по">
                        <Input size="sm" type="date"
                          value={editDoc?.period_to ?? selectedDoc.period_to?.slice(0,10)}
                          onChange={e => setEditDoc(prev => ({ ...(prev || { name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }), period_to: e.target.value }))}
                          onFocus={() => { if (!editDoc) setEditDoc({ name: selectedDoc.name, period_from: selectedDoc.period_from?.slice(0,10), period_to: selectedDoc.period_to?.slice(0,10) }) }}
                        />
                      </Field>
                    </div>
                    {editDoc && (
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" variant="primary" onClick={saveDocSettings}>Сохранить</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditDoc(null)}>Отмена</Button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {selectedDoc && <>
          <span className="hidden sm:block w-px h-6 bg-gray-200 mx-1" />

          <Segmented value={granularity} onChange={setGranularity} options={[
            { value: 'day', label: 'По дням' },
            { value: 'month', label: 'По месяцам' },
          ]} className="h-8 items-center" />

          <Segmented value={viewMode} onChange={setViewMode} options={[
            { value: 'plan', label: 'План' },
            { value: 'fact', label: 'Факт' },
            { value: 'plan_fact', label: 'План + факт' },
          ]} className="h-8 items-center" />

          <Segmented value={byCash} onChange={setByCash} options={[
            { value: false, label: 'Общая сумма' },
            { value: true, label: 'По кассам' },
          ]} className="h-8 items-center" />

          {/* Показать с — расширение влево: факт прошлых дней перед календарём */}
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs text-gray-500" title="Показать факт прошлых дней перед началом календаря">Показать с</span>
            <input type="date"
              className="h-8 px-2 border border-gray-200 rounded-lg text-xs bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
              value={displayFrom}
              onChange={e => setDisplayFrom(e.target.value)}
              max={selectedDoc?.period_from?.slice(0, 10)} />
            {displayFrom && <IconButton icon={X} size="sm" label="Вернуть начало календаря" onClick={() => setDisplayFrom('')} />}
          </div>
        </>}
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-4"><SkeletonRows rows={10} height="h-8" /></div>
      ) : loadError ? (
        <div className="bg-white rounded-xl border border-gray-200/80 shadow-card">
          <ErrorState title="Не удалось загрузить календарь" onRetry={() => loadReport()} />
        </div>
      ) : !report ? (
        <div className="text-center py-20 text-gray-500">{documents.length === 0 ? 'Создайте первый платёжный календарь' : 'Выберите календарь'}</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200/80 shadow-card overflow-hidden">
          {/* Индикатор буфера обмена */}
          {(clipboard || pasting) && (
            <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
              <span className="text-xs text-blue-700">
                {pasting
                  ? 'Вставка...'
                  : <>Скопировано: <span className="font-medium">{clipboard.articleName}</span> / {granularity === 'day' ? new Date(clipboard.periodDate + 'T00:00:00').toLocaleDateString('ru-RU') : monthLabel(clipboard.periodDate)} — ПКМ на ячейку плана для вставки</>
                }
              </span>
              {!pasting && (
                <button onClick={() => setClipboard(null)} className="text-2xs text-blue-600 hover:text-blue-800">Очистить</button>
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
                        today ? 'bg-gold-50 text-gold-800' :
                        weekend ? 'bg-gray-100 text-gray-500' :
                        'text-gray-700'
                      }`} style={{ width: colWidth, minWidth: colWidth }}>
                        {granularity === 'day' ? (
                          <div className="flex flex-col items-center leading-tight">
                            <span className="text-2xs uppercase">{dowShort(pd)}</span>
                            <span className="text-sm font-semibold">{dayShort(pd)}</span>
                            <span className={`text-2xs ${today ? 'text-gold-700 font-medium' : 'text-gray-400'}`}>{today ? 'сегодня' : monthShort(pd)}</span>
                          </div>
                        ) : (
                          <div className="text-xs capitalize">{monthLabel(pd)}</div>
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
                        today ? 'bg-gold-50/60' : weekend ? 'bg-gray-50' : ''
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
                        const future = isBlankFuture(pd)
                        const cellBg = today ? 'bg-gold-50/60' : weekend ? 'bg-gray-50' : ''
                        const isCopied = clipboard && clipboard.articleId === article.id && clipboard.periodDate === pd
                        const canPaste = !!clipboard && clipboard.articleId === article.id && clipboard.periodDate !== pd
                        const copiedCls = isCopied ? 'outline outline-2 outline-dashed outline-brand-400 outline-offset-[-2px]' : ''

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
                              className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 cursor-pointer hover:bg-brand-50 ${cellBg} ${copiedCls} ${planVal ? 'text-brand-700' : 'text-gray-300'}`}
                              onClick={planClick}
                              onContextMenu={planContext}
                              title={canPaste ? 'ПКМ — вставить' : isCopied ? 'Скопировано — ПКМ на другой ячейке для вставки' : 'ЛКМ — редактировать, ПКМ — скопировать'}>
                              {fmtCell(planVal)}
                            </td>
                          )
                        }
                        if (viewMode === 'fact') {
                          return (
                            <td key={pd} className={`text-right px-2 py-1.5 tabular-nums border-l border-gray-100 ${cellBg} ${future ? 'text-gray-300' : factVal < 0 ? 'text-red-600' : factVal > 0 ? 'text-gray-700' : 'text-gray-300'} ${factVal && !future ? 'cursor-pointer hover:bg-gray-100' : ''}`}
                              onClick={() => factVal && !future && openDrawer(article.id, article.name, pd)}>
                              {future ? '—' : fmtCell(factVal)}
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
                                className={`text-xs tabular-nums text-right px-2 pt-1 pb-0.5 hover:bg-brand-50 ${planVal ? 'text-brand-700 font-medium' : 'text-gray-300'}`}>
                                {fmtCell(planVal) || '\u00A0'}
                              </button>
                              {/* \u0424\u0430\u043A\u0442 \u0442\u0435\u043C \u0436\u0435 \u043A\u0435\u0433\u043B\u0435\u043C, \u0447\u0442\u043E \u0438 \u043F\u043B\u0430\u043D: \u0440\u0430\u0437\u043D\u044B\u043C\u0438 \u0438\u0445 \u0434\u0435\u0440\u0436\u0430\u0442 \u0446\u0432\u0435\u0442 \u0438
                                  \u043D\u0430\u0441\u044B\u0449\u0435\u043D\u043D\u043E\u0441\u0442\u044C, \u0430 \u043D\u0435 \u0440\u0430\u0437\u043C\u0435\u0440. \u041C\u0435\u043B\u043A\u0438\u0439 \u0432\u0442\u043E\u0440\u043E\u0439 \u0440\u044F\u0434 \u0446\u0438\u0444\u0440 \u0433\u043B\u0430\u0437
                                  \u0447\u0438\u0442\u0430\u0435\u0442 \u043A\u0430\u043A \u0441\u043D\u043E\u0441\u043A\u0443, \u0445\u043E\u0442\u044F \u044D\u0442\u043E \u0442\u0430\u043A\u0430\u044F \u0436\u0435 \u0441\u0443\u043C\u043C\u0430 */}
                              <button
                                onClick={() => factClickable && openDrawer(article.id, article.name, pd)}
                                disabled={!factClickable}
                                className={`text-xs tabular-nums text-right px-2 pt-0.5 pb-1 ${
                                  future ? 'text-gray-300' :
                                  factVal < 0 ? 'text-red-600' :
                                  factVal > 0 ? 'text-gray-600' :
                                  'text-gray-300'
                                } ${factClickable ? 'hover:bg-gray-100 cursor-pointer' : 'cursor-default'}`}>
                                {future ? '—' : (fmtCell(factVal) || '\u00A0')}
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
                        today ? 'bg-gold-50/60' : weekend ? 'bg-gray-50' : ''
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
                        today ? 'bg-gold-50 text-gold-900' :
                        weekend ? 'bg-gray-100 text-gray-700' :
                        'text-gray-800'
                      }`}
                        title={gap ? 'Кассовый разрыв: денег на конец дня не хватает' : ''}>
                        <span className="inline-flex items-center justify-end gap-1 w-full">
                          {gap && <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                          {fmt(b.closing)}
                        </span>
                      </td>
                    )
                  })}
                </tr>

                {/* По кассам */}
                {byCash && cashItems.map(ci => (
                  <tr key={`cc_${ci.id}`} className="border-b border-gray-50">
                    <td className="sticky left-0 z-10 bg-white px-3 py-1 text-gray-600 text-xs" style={{ paddingLeft: 28 }}>{ci.name}</td>
                    {periodDates.map((pd, i) => {
                      const cb = cashBalances[ci.id]?.[i]
                      const gap = cb && cb.closing < 0
                      return (
                        <td key={pd} className={`text-right px-2 py-1 tabular-nums text-xs border-l border-gray-100 ${gap ? 'bg-red-50 text-red-600 font-medium' : 'text-gray-500'}`}>
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
          <div className="px-4 py-3 border-t border-gray-100 flex gap-x-5 gap-y-1.5 text-xs text-gray-500 flex-wrap">
            {showPlan && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-brand-600" /> План: клик — править, правый клик — копировать и вставить</span>}
            {showFact && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500" /> Факт: клик — расшифровка</span>}
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 border border-red-300" /> Кассовый разрыв</span>
            {granularity === 'day' && <>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-gold-50 border border-gold-300" /> Сегодня</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-gray-100 border border-gray-300" /> Выходной</span>
            </>}
            <span className="italic">Курсивом — прогноз по плану</span>
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
      <input ref={ref} type="text" className="w-full text-right text-xs px-1 py-0.5 border border-brand-300 rounded bg-white text-brand-700"
        value={text} onChange={e => setText(e.target.value)}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }} />
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`cursor-pointer hover:underline ${isManual ? 'text-brand-700' : ''}`}
        onDoubleClick={() => { setText(String(Math.round(value || 0))); setEditing(true) }}
        title="Двойной клик для редактирования">
        {fmt(value)}
      </span>
      {isManual && (
        <button onClick={onReset} title="Вернуть остаток, посчитанный по оборотам" aria-label="Вернуть остаток, посчитанный по оборотам"
          className="p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}
