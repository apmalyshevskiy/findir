import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { parseBankStatement } from '../api/bankStatements'
import { createOperation, updateOperation, deleteOperation, getOperations } from '../api/operations'
import { getInfo } from '../api/info'
import { getBalanceItems } from '../api/operations'
import { classifyStatement, applyRules } from '../api/ai'
import Layout from '../components/Layout'
import InfoSelect from '../components/InfoSelect'
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Check, CheckCircle2, ChevronDown, Copy, FileUp, Link2, Pencil,
  Plus, RotateCcw, Save, Sparkles, X,
} from 'lucide-react'
import { apiError, confirm, toast, Badge, Button, IconButton, PageHeader } from '../components/ui'
import { date as fmtDate } from '../utils/format'
import { slotLabel, slotAccepts, slotSelect } from '../utils/analyticSlots'

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n) => n == null ? '—' : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

// ── Строка операции внутри строки выписки ─────────────────────────────────────
const OperationLine = ({ op, totalAmount, isOnly, balanceItems, infoCache, direction, counterpartyInn, counterpartyAccount, suggestedExpenseId, onChange, onRemove, onInfoCreated }) => {
  const ic = 'w-full h-8 px-2 text-xs bg-white border border-gray-200 rounded-lg hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500'

  // ── Нога комиссии эквайринг-свода: свободный режим, обе стороны — обычные счета ──
  // Не привязана к А100. Дт (in) и Кт (out) выбираются вручную; аналитика info_1
  // каждой ноги — по типу её счёта.
  if (op._kind === 'fee') {
    const dtBi = balanceItems.find(b => b.id == op.in_bi_id)
    const ktBi = balanceItems.find(b => b.id == op.out_bi_id)
    const dtInfo1Type = dtBi?.info_1_type || null
    const ktInfo1Type = ktBi?.info_1_type || null
    const acctOption = (b) => (
      <option key={b.id} value={b.id}>{b.code} {b.name.replace(/^[А-ЯA-Z]\d+\s/, '')}</option>
    )
    return (
      <div className="space-y-2 p-2 bg-amber-50 rounded-lg border border-amber-100">
        <div className="text-xs text-amber-800 font-medium">Комиссия эквайринга — отдельная операция</div>
        <div className="grid gap-x-2 gap-y-1.5" style={{ gridTemplateColumns: '110px 1fr 1fr 24px' }}>
          {/* Сумма */}
          <div>
            <div className="text-2xs font-medium text-gray-500 mb-1">Сумма</div>
            <input type="number" step="0.01" className={ic}
              value={op.amount || ''}
              onChange={e => onChange({ ...op, amount: parseFloat(e.target.value) || 0 })} />
          </div>
          {/* Счёт Дт (расход) */}
          <div>
            <div className="text-2xs font-medium text-gray-500 mb-1">Счёт Дт</div>
            <select className={ic} value={op.in_bi_id || ''}
              onChange={e => onChange({ ...op, in_bi_id: parseInt(e.target.value) || null, in_info_1_id: null })}>
              <option value="">— Выбрать счёт —</option>
              {balanceItems.map(acctOption)}
            </select>
          </div>
          {/* info_1 ноги Дт */}
          {dtInfo1Type ? (
            <div>
              <div className="text-2xs font-medium text-gray-500 mb-1">{slotLabel(dtInfo1Type)}</div>
              <InfoSelect {...slotSelect(dtInfo1Type, infoCache, onInfoCreated)} value={op.in_info_1_id}
                onChange={v => onChange({ ...op, in_info_1_id: v })} placeholder="Выбрать..." />
            </div>
          ) : <div />}
          {/* Удалить */}
          <div className="flex items-end justify-center">
            {!isOnly && (
              <IconButton icon={X} size="sm" variant="danger" label="Убрать эту операцию" onClick={onRemove} />
            )}
          </div>
        </div>
        <div className="grid gap-x-2" style={{ gridTemplateColumns: ktInfo1Type ? '1fr 1fr' : '1fr' }}>
          {/* Счёт Кт (доход, наследован) */}
          <div>
            <div className="text-2xs font-medium text-gray-500 mb-1">Счёт Кт</div>
            <select className={ic} value={op.out_bi_id || ''}
              onChange={e => onChange({ ...op, out_bi_id: parseInt(e.target.value) || null, out_info_1_id: null })}>
              <option value="">— Выбрать счёт —</option>
              {balanceItems.map(acctOption)}
            </select>
          </div>
          {/* info_1 ноги Кт */}
          {ktInfo1Type && (
            <div>
              <div className="text-2xs font-medium text-gray-500 mb-1">{slotLabel(ktInfo1Type)}</div>
              <InfoSelect {...slotSelect(ktInfo1Type, infoCache, onInfoCreated)} value={op.out_info_1_id}
                onChange={v => onChange({ ...op, out_info_1_id: v })} placeholder="Выбрать..." />
            </div>
          )}
        </div>
      </div>
    )
  }

  // А100 — наша сторона (зафиксирована)
  const a100 = balanceItems.find(b => b.code === 'А100')

  // Корреспондирующий счёт — выбирается пользователем
  const counterBiField = direction === 'in' ? 'out_bi_id' : 'in_bi_id'
  const counterBi = balanceItems.find(b => b.id == op[counterBiField])

  // Аналитика А100: info_2=flow
  const a100Info2Type  = a100?.info_2_type
  const a100Info2Field = direction === 'in' ? 'in_info_2_id' : 'out_info_2_id'

  // Аналитика корреспондирующего счёта
  const counterInfo1Type  = counterBi?.info_1_type || null
  const counterInfo2Type  = counterBi?.info_2_type || null
  const counterInfo1Field = direction === 'in' ? 'out_info_1_id' : 'in_info_1_id'
  const counterInfo2Field = direction === 'in' ? 'out_info_2_id' : 'in_info_2_id'

  // Когда меняем корреспондирующий счёт — сбрасываем аналитику
  // и пробуем подобрать партнёра по ИНН если слот принимает контрагента
  const handleCounterBiChange = (biId) => {
    const newBi = balanceItems.find(b => b.id == biId)

    // ── Перевод между своими счетами: корр-счёт тоже А100 ──
    // Обе ноги = А100, статья «Перемещение денег» на ОБЕИХ (иначе переток
    // не схлопнётся в ОСВ). Касса-получатель ищется по номеру счёта из выписки.
    if (newBi?.code === 'А100') {
      const flows = infoCache['flow'] || []
      const moveFlow = flows.find(f => (f.name || '').toLowerCase().includes('перемещение денег'))

      // Подбор кассы-получателя: ищем номер счёта-контрагента в code/name/description
      let destCash = null
      if (counterpartyAccount) {
        const acc = String(counterpartyAccount).trim()
        const found = (infoCache['cash'] || []).find(c =>
          (c.code || '').includes(acc) ||
          (c.name || '').includes(acc) ||
          (c.description || '').includes(acc)
        )
        if (found) destCash = found.id
      }

      onChange({
        ...op,
        [counterBiField]:    biId,
        [counterInfo1Field]: destCash,             // касса-получатель (или вручную)
        [counterInfo2Field]: moveFlow?.id || null, // ДДС на корр-ноге
        [a100Info2Field]:    moveFlow?.id || null, // ДДС на нашей ноге — обе должны совпадать
      })
      return
    }

    // ── Обычный корр-счёт: сброс аналитики + автоподстановка info_1 ──
    //  - expenses → статья расхода (suggested_expense_id);
    //  - partner  → контрагент по ИНН.
    let autoInfo1 = null
    if (slotAccepts(newBi?.info_1_type, 'expenses')) {
      autoInfo1 = suggestedExpenseId || null
    } else if (slotAccepts(newBi?.info_1_type, 'partner') && counterpartyInn) {
      const partners = infoCache['partner'] || []
      const found = partners.find(p => p.inn && p.inn.trim() === counterpartyInn.trim())
      if (found) autoInfo1 = found.id
    }

    onChange({
      ...op,
      [counterBiField]:   biId,
      [counterInfo1Field]: autoInfo1,
      [counterInfo2Field]: null,
    })
  }

  return (
    <div className="space-y-2 p-2 bg-gray-50 rounded-lg border border-gray-100">
      <div className="grid gap-x-2 gap-y-1.5" style={{ gridTemplateColumns: '110px 1fr 1fr 24px' }}>

        {/* Сумма */}
        <div>
          <div className="text-2xs font-medium text-gray-500 mb-1">Сумма</div>
          <input
            type="number" step="0.01"
            className={ic + (Math.abs(op.amount || 0) > totalAmount ? ' border-red-400' : '')}
            value={op.amount || ''}
            onChange={e => onChange({ ...op, amount: parseFloat(e.target.value) || 0 })}
          />
        </div>

        {/* А100 — фиксированная наша сторона */}
        <div>
          <div className="text-2xs font-medium text-gray-500 mb-1">
            {direction === 'in' ? 'Счёт Дт' : 'Счёт Кт'} (А100)
          </div>
          <div className="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded border border-blue-100 truncate">
            {a100 ? `${a100.code} ДЕНЕЖНЫЕ СРЕДСТВА` : 'А100'}
          </div>
        </div>

        {/* Статья ДДС — info_2 стороны А100 */}
        {a100Info2Type && (
          <div>
            <div className="text-2xs font-medium text-gray-500 mb-1">{slotLabel(a100Info2Type)}</div>
            <InfoSelect
              {...slotSelect(a100Info2Type, infoCache, onInfoCreated)}
              value={op[a100Info2Field]}
              onChange={v => onChange({ ...op, [a100Info2Field]: v })}
              placeholder="Выбрать..."
            />
          </div>
        )}

        {/* Удалить */}
        <div className="flex items-end justify-center">
          {!isOnly && (
            <IconButton icon={X} size="sm" variant="danger" label="Убрать эту операцию" onClick={onRemove} />
          )}
        </div>
      </div>

      {/* Корреспондирующий счёт + его аналитика */}
      <div className="grid gap-x-2" style={{ gridTemplateColumns: counterInfo1Type ? (counterInfo2Type ? '1fr 1fr 1fr' : '1fr 1fr') : '1fr' }}>

        {/* Корреспондирующий счёт */}
        <div>
          <div className="text-2xs font-medium text-gray-500 mb-1">
            {direction === 'in' ? 'Счёт Кт' : 'Счёт Дт'}
          </div>
          <select
            className={ic}
            value={op[counterBiField] || ''}
            onChange={e => handleCounterBiChange(parseInt(e.target.value) || null)}
          >
            <option value="">— Выбрать счёт —</option>
            {balanceItems.map(b => (
              <option key={b.id} value={b.id}>
                {b.code} {b.name.replace(/^[А-ЯA-Z]\d+\s/, '')}
              </option>
            ))}
          </select>
        </div>

        {/* Аналитика 1 корреспондирующего счёта */}
        {counterInfo1Type && (
          <div>
            <div className="text-2xs font-medium text-gray-500 mb-1">
              {slotLabel(counterInfo1Type)}
              {/* Подсказка если ИНН есть но партнёр не найден */}
              {slotAccepts(counterInfo1Type, 'partner') && counterpartyInn && !op[counterInfo1Field] && (
                <span className="ml-1 inline-flex align-[-2px] text-amber-600" title={`ИНН ${counterpartyInn} не найден в справочнике`}>
                  <AlertTriangle className="w-3 h-3" aria-label="не найден" />
                </span>
              )}
              {slotAccepts(counterInfo1Type, 'partner') && counterpartyInn && op[counterInfo1Field] && (
                <span className="ml-1 inline-flex align-[-2px] text-emerald-600" title={`Найден по ИНН ${counterpartyInn}`}>
                  <Check className="w-3 h-3" aria-label="найден" />
                </span>
              )}
            </div>
            <InfoSelect
              {...slotSelect(counterInfo1Type, infoCache, onInfoCreated)}
              value={op[counterInfo1Field]}
              onChange={v => onChange({ ...op, [counterInfo1Field]: v })}
              placeholder={slotAccepts(counterInfo1Type, 'partner') && counterpartyInn ? `ИНН ${counterpartyInn}...` : 'Выбрать...'}
            />
          </div>
        )}

        {/* Аналитика 2 корреспондирующего счёта */}
        {counterInfo2Type && (
          <div>
            <div className="text-2xs font-medium text-gray-500 mb-1">{slotLabel(counterInfo2Type)}</div>
            <InfoSelect
              {...slotSelect(counterInfo2Type, infoCache, onInfoCreated)}
              value={op[counterInfo2Field]}
              onChange={v => onChange({ ...op, [counterInfo2Field]: v })}
              placeholder="Выбрать..."
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Строка выписки ────────────────────────────────────────────────────────────
const StatementRow = ({ row, projectId, cashInfoId, balanceItems, infoCache, forcedIgnored, onOperationsChange, onInfoCreated }) => {
  const a100 = balanceItems.find(b => b.code === 'А100')
  const a100Id = a100?.id

  const [innCopied, setInnCopied] = useState(false)
  const copyInn = (e) => {
    e.stopPropagation()
    if (!row.counterparty_inn) return
    navigator.clipboard?.writeText(String(row.counterparty_inn))
    setInnCopied(true)
    setTimeout(() => setInnCopied(false), 1200)
  }

  // ── Распознавание перевода между своими счетами ──
  // Флаг приходит из бэкенда (ИНН плательщика == ИНН получателя в документе).
  const isSelfTransfer = !!row.is_self_transfer

  // Статья «Перемещение денег» — по подстроке в справочнике ДДС
  const moveFlowId = (infoCache['flow'] || [])
    .find(f => (f.name || '').toLowerCase().includes('перемещение денег'))?.id || null

  // Касса-получатель — по номеру счёта-контрагента из выписки (code → name → description)
  const findDestCashId = () => {
    if (!row.counterparty_account) return null
    const acc = String(row.counterparty_account).trim()
    const f = (infoCache['cash'] || []).find(c =>
      (c.code || '').includes(acc) || (c.name || '').includes(acc) || (c.description || '').includes(acc))
    return f?.id || null
  }

  const makeDefaultOp = () => {
    const op = { amount: row.amount }

    const suggestedCounterBi = row.suggested_counter_bi_id || null
    const counterBi    = isSelfTransfer ? (a100Id || null) : suggestedCounterBi

    // info_1 корр-ноги: перевод → касса; expenses → статья расхода; иначе партнёр.
    const counterBiItem = balanceItems.find(b => b.id == counterBi)
    let counterInfo1
    if (isSelfTransfer) {
      counterInfo1 = findDestCashId()
    } else if (counterBiItem?.info_1_type === 'expenses') {
      counterInfo1 = row.suggested_expense_id || null
    } else {
      counterInfo1 = row.suggested_partner_id || null
    }

    const ourFlow     = isSelfTransfer ? moveFlowId : (row.suggested_flow_id || null)
    const counterFlow = isSelfTransfer ? moveFlowId : null

    if (row.direction === 'in') {
      op.in_bi_id      = a100Id || null
      op.in_info_1_id  = cashInfoId || null
      op.in_info_2_id  = ourFlow
      op.out_bi_id     = counterBi
      op.out_info_1_id = counterInfo1
      op.out_info_2_id = counterFlow
    } else {
      op.out_bi_id     = a100Id || null
      op.out_info_1_id = cashInfoId || null
      op.out_info_2_id = ourFlow
      op.in_bi_id      = counterBi
      op.in_info_1_id  = counterInfo1
      op.in_info_2_id  = counterFlow
    }
    return op
  }

  // Операция комиссии эквайринг-свода (вторая нога). НЕ привязана к А100:
  // обе стороны — обычные счета. Помечена _kind='fee', чтобы рендер и сохранение
  // не навязывали ей фиксированную ногу А100.
  //   Дт = suggested_fee_bi_id (П589, расход) + статья расхода (info_1)
  //   Кт = наследует доходный счёт приходной операции (incomeOp.out_bi_id) + его info_1
  //
  // Статью ДДС этой операции НЕ проставляем: денег она не двигает — банк удержал
  // комиссию из выручки, на счёт пришло уже нетто. Движение денег целиком описано
  // приходной ногой (Дт А100 + «Поступление от клиентов»), и статья ДДС здесь
  // задваивала бы поступление в отчётах ДДС.
  // suggested_fee_flow_id при этом продолжает работать — из него выводится
  // статья расхода (defaultExpenseForFlow на бэкенде).
  const makeFeeOp = (incomeOp) => {
    return {
      _kind: 'fee',
      amount: row.suggested_fee_amount || 0,
      in_bi_id:      row.suggested_fee_bi_id || null,       // П589 расход (Дт)
      in_info_1_id:  row.suggested_fee_expense_id || null,  // статья расхода на П589
      in_info_2_id:  null,                                  // статья ДДС — не для этой ноги
      out_bi_id:     incomeOp.out_bi_id || null,            // доходный счёт прихода (Кт, наследуем)
      out_info_1_id: incomeOp.out_info_1_id || null,
      out_info_2_id: null,
    }
  }

  // Начальный набор операций: эквайринг-свод → [приход нетто, комиссия].
  const makeDefaultOps = () => {
    const incomeOp = makeDefaultOp()
    if (row.is_acquiring_split && row.suggested_fee_amount) {
      return [incomeOp, makeFeeOp(incomeOp)]
    }
    return [incomeOp]
  }

  const [ops, setOps] = useState(makeDefaultOps())
  const [expanded, setExpanded] = useState(false)
  const [ignored, setIgnored] = useState(false)

  // Массовое управление выбором из родителя («Снять все» / «Выбрать все»).
  // forcedIgnored — { value: bool, nonce: number }; nonce меняется на каждое
  // нажатие, чтобы повторное «Снять все» тоже срабатывало.
  const forcedNonce = forcedIgnored?.nonce
  useEffect(() => {
    if (forcedNonce === undefined) return
    if (postedIds.length > 0) return   // уже созданные не трогаем
    setIgnored(!!forcedIgnored.value)
  }, [forcedNonce])
  const [reloading, setReloading] = useState(false)
  const [loadingOps, setLoadingOps] = useState(false)
  const [savedOps, setSavedOps] = useState(null) // снимок для отмены
  // Локальный список уже созданных id (можно обновить после пересоздания)
  const [postedIds, setPostedIds] = useState(row.existing_operation_ids || [])

  // На момент монтирования план счетов и справочники могут быть ещё не загружены,
  // поэтому makeDefaultOp() в useState даёт неполный результат. Когда данные приедут —
  // один раз пересобираем дефолтную операцию (если строка не создана и не редактировалась).
  const autoApplied = useRef(false)
  useEffect(() => {
    if (autoApplied.current) return
    if (postedIds.length > 0) return          // уже созданные не трогаем
    if (!a100Id) return                        // ждём план счетов
    if (isSelfTransfer && !moveFlowId) return   // для перевода ждём статью ДДС, чтобы не оставить пусто
    autoApplied.current = true
    setOps(makeDefaultOps())
  }, [a100Id, moveFlowId, isSelfTransfer, infoCache, cashInfoId, postedIds.length])

  // Загрузить данные существующих операций и заполнить форму
  const loadAndExpand = async () => {
    if (expanded) { setExpanded(false); return }
    if (postedIds.length === 0) { setExpanded(true); return }
    setLoadingOps(true)
    try {
      const res = await getOperations({ ids: postedIds.join(','), per_page: 50 })
      const list = res.data.data || []
      // Сортируем в том же порядке что postedIds
      const loaded = postedIds
        .map(id => list.find(o => o.id === id))
        .filter(Boolean)
        .map(o => ({
          amount:        parseFloat(o.amount),
          in_bi_id:      o.in_bi_id,
          in_info_1_id:  o.in_info_1_id,
          in_info_2_id:  o.in_info_2_id,
          out_bi_id:     o.out_bi_id,
          out_info_1_id: o.out_info_1_id,
          out_info_2_id: o.out_info_2_id,
        }))
      if (loaded.length > 0) { setOps(loaded); setSavedOps(loaded) }
      setExpanded(true)
    } catch(e) {
      setExpanded(true) // Открываем с дефолтными данными если не удалось
    } finally {
      setLoadingOps(false)
    }
  }

  const distributed = ops.reduce((s, o) => s + (parseFloat(o.amount) || 0), 0)
  // Целевая сумма распределения. Для эквайринг-свода нога комиссии добавляется
  // СВЕРХ нетто, поэтому цель = нетто (amount) + комиссия.
  const feeExtra    = (row.is_acquiring_split && row.suggested_fee_amount) ? row.suggested_fee_amount : 0
  const targetAmount = Math.round((row.amount + feeExtra) * 100) / 100
  const remainder   = Math.round((targetAmount - distributed) * 100) / 100

  const isPosted  = postedIds.length > 0
  // isReady — заполнены все обязательные поля (не зависит от isPosted)
  const isReady = !ignored && ops.every(op => {
    if (op._kind === 'fee') {
      return op.in_bi_id && op.out_bi_id && (parseFloat(op.amount) || 0) > 0
    }
    const hasFlow    = row.direction === 'in' ? op.in_info_2_id : op.out_info_2_id
    const hasCounter = row.direction === 'in' ? op.out_bi_id : op.in_bi_id
    return hasFlow && hasCounter && (parseFloat(op.amount) || 0) > 0
  }) && Math.abs(remainder) < 0.01
  // isMatched — для новых строк (не загруженных) — управляет статусом «✓ Готово»
  const isMatched = isReady && !isPosted

  // Синхронизируем вверх: операции, признак «пропущена», готовность.
  // readyForCreate — строку реально можно создать (готова, не пропущена, не создана).
  const readyForCreate = isReady && !ignored && !isPosted
  useEffect(() => {
    onOperationsChange(ops, ignored, false, readyForCreate)
  }, [ops, ignored, readyForCreate])

  // Полоса слева — состояние строки: глаз пробегает список по цвету и видит,
  // сколько ещё не размечено, не читая каждую строку
  const statusColor = isPosted
    ? 'bg-white border-l-emerald-500'
    : ignored
    ? 'bg-gray-50 border-l-gray-300 opacity-60'
    : isMatched
    ? 'bg-white border-l-brand-500'
    : 'bg-white border-l-amber-400'

  return (
    <div className={`rounded-xl border border-gray-200/80 border-l-4 shadow-card mb-2 overflow-hidden ${statusColor}`}>
      {/* Заголовок строки */}
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-gray-50/80 transition-colors"
        onClick={() => !ignored && setExpanded(e => !e)}
      >
        {/* Направление */}
        <span title={row.direction === 'in' ? 'Поступление' : 'Списание'}
          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${row.direction === 'in' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'}`}>
          {row.direction === 'in'
            ? <ArrowDownLeft className="w-4 h-4" aria-label="Поступление" />
            : <ArrowUpRight className="w-4 h-4" aria-label="Списание" />}
        </span>

        {/* Дата + тип документа */}
        <div className="w-32 shrink-0">
          <div className="text-sm text-gray-700 tabular-nums">{fmtDate(row.doc_date)}</div>
          <div className="text-xs text-gray-500">{row.doc_type?.replace('Платежное поручение', 'П/П') || ''} №{row.doc_number}</div>
        </div>

        {/* Сумма */}
        <div className={`w-32 shrink-0 text-right text-sm font-semibold tabular-nums ${row.direction === 'in' ? 'text-emerald-700' : 'text-gray-900'}`}>
          {row.direction === 'in' ? '+' : '−'}{fmt(row.amount)}
        </div>

        {/* Контрагент */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-800 truncate">{row.counterparty_raw || '—'}</div>
          {row.counterparty_inn && (
            <button
              type="button"
              onClick={copyInn}
              title="Скопировать ИНН"
              className="inline-flex items-center gap-1 text-xs font-mono text-gray-500 hover:text-brand-700"
            >
              ИНН {row.counterparty_inn}
              {innCopied
                ? <Check className="w-3 h-3 text-emerald-600" aria-label="скопировано" />
                : <Copy className="w-3 h-3 text-gray-400" aria-hidden="true" />}
            </button>
          )}
          <div className="mt-0.5 text-xs text-gray-500 leading-snug line-clamp-2 break-words">{row.purpose_raw || ''}</div>
        </div>

        {/* Статус */}
        <div className="w-44 shrink-0 flex items-center justify-end gap-2">
          {isPosted ? (
            <>
              <Badge tone="green"><Link2 className="w-3 h-3" aria-hidden="true" />Создано · {postedIds.length}</Badge>
              <Button size="xs" variant="ghost" icon={Pencil} loading={loadingOps}
                onClick={e => { e.stopPropagation(); loadAndExpand() }} title="Поправить созданные операции">
                Изменить
              </Button>
            </>
          ) : ignored ? (
            <Badge tone="gray">Пропущено</Badge>
          ) : isMatched ? (
            <Badge tone="brand"><CheckCircle2 className="w-3 h-3" aria-hidden="true" />Готово</Badge>
          ) : (
            <Badge tone="amber">Не размечено</Badge>
          )}
        </div>

        {/* Пропустить строку — словом, а не значком ⊘: значок никто не
            опознавал, и строки, которые не нужны, создавались операциями */}
        {!isPosted && (
          <button
            onClick={e => { e.stopPropagation(); setIgnored(v => !v) }}
            className="w-20 shrink-0 text-xs text-gray-500 hover:text-gray-900 hover:underline underline-offset-2"
            title={ignored ? 'Вернуть строку к разметке' : 'Не создавать по этой строке операций'}
          >
            {ignored ? 'Вернуть' : 'Пропустить'}
          </button>
        )}

        {/* Раскрыть разметку */}
        {(!isPosted || expanded) && !ignored ? (
          <span className="shrink-0 text-gray-400" onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}>
            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-label={expanded ? 'Свернуть' : 'Раскрыть'} />
          </span>
        ) : <span className="w-4 shrink-0" />}
      </div>

      {/* Панель разметки */}
      {expanded && !ignored && (
        <div className="px-4 pt-1 pb-4 space-y-2 border-t border-gray-100 bg-gray-50/50">
          {ops.map((op, idx) => (
            <OperationLine
              key={idx}
              op={op}
              totalAmount={row.amount}
              isOnly={ops.length === 1}
              balanceItems={balanceItems}
              infoCache={infoCache}
              onInfoCreated={onInfoCreated}
              direction={row.direction}
              counterpartyInn={row.counterparty_inn}
              counterpartyAccount={row.counterparty_account}
              suggestedExpenseId={row.suggested_expense_id}
              onChange={v => setOps(ops.map((o, i) => i === idx ? v : o))}
              onRemove={() => setOps(ops.filter((_, i) => i !== idx))}
            />
          ))}

          {/* Счётчик распределения */}
          {ops.length > 1 && (
            <div className={`text-xs px-2.5 py-1.5 rounded-lg ${Math.abs(remainder) < 0.01 ? 'text-emerald-700 bg-emerald-50' : 'text-amber-800 bg-amber-50'}`}>
              Распределено: {fmt(distributed)} из {fmt(targetAmount)}
              {Math.abs(remainder) > 0.01 && ` · Остаток: ${fmt(remainder)}`}
            </div>
          )}

          {/* Кнопка «Разбить» */}
          <Button size="xs" variant="ghost" icon={Plus} className="text-brand-700"
            onClick={() => setOps([...ops, { ...makeDefaultOp(), amount: Math.max(0, remainder) }])}>
            Разбить на несколько операций
          </Button>

          {/* Кнопка сохранения изменений — перезаписываем существующие операции */}
          {isPosted && (
            <div className="pt-2 border-t border-gray-200 flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">
                Созданные операции ({postedIds.length}) будут обновлены, а не созданы заново
              </span>
              <div className="flex gap-2">
              <Button size="sm" variant="ghost"
                onClick={() => {
                  if (savedOps) setOps(savedOps)
                  setExpanded(false)
                }}>
                Отмена
              </Button>
              <Button size="sm" variant="primary" icon={Save} loading={reloading}
                disabled={!isReady}
                onClick={async () => {
                  setReloading(true)
                  try {
                    // buildPayload — формируем тело как при создании
                    const buildPayload = (op) => {
                      const a100 = balanceItems.find(b => b.code === 'А100')
                      const base = {
                        date:          row.doc_date,
                        project_id:    parseInt(projectId) || null,
                        amount:        parseFloat(op.amount),
                        source:        'bank_import',
                        note:          row.note,
                        content:       row.purpose_raw || '',
                        in_bi_id:      op.in_bi_id,
                        out_bi_id:     op.out_bi_id,
                        in_info_1_id:  op.in_info_1_id || null,
                        in_info_2_id:  op.in_info_2_id || null,
                        out_info_1_id: op.out_info_1_id || null,
                        out_info_2_id: op.out_info_2_id || null,
                      }
                      if (op._kind !== 'fee') {
                        if (row.direction === 'in') {
                          base.in_bi_id     = a100?.id
                          base.in_info_1_id = parseInt(cashInfoId) || null
                        } else {
                          base.out_bi_id    = a100?.id
                          base.out_info_1_id = parseInt(cashInfoId) || null
                        }
                      }
                      return base
                    }

                    const newIds = []
                    for (let i = 0; i < ops.length; i++) {
                      const payload = buildPayload(ops[i])
                      if (i < postedIds.length) {
                        // Обновляем существующую
                        await updateOperation(postedIds[i], payload)
                        newIds.push(postedIds[i])
                      } else {
                        // Новых операций стало больше — создаём
                        const res = await createOperation(payload)
                        newIds.push(res.data.data.id)
                      }
                    }
                    // Если операций стало меньше — удаляем лишние
                    for (let i = ops.length; i < postedIds.length; i++) {
                      await deleteOperation(postedIds[i])
                    }
                    setPostedIds(newIds)
                    setExpanded(false)
                    toast.success('Операции обновлены')
                  } catch(e) {
                    toast.error(apiError(e, e.message))
                  } finally {
                    setReloading(false)
                  }
                }}
              >
                Сохранить изменения
              </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Главная страница ──────────────────────────────────────────────────────────
export default function BankStatementPage() {
  const navigate = useNavigate()

  const [dragging, setDragging] = useState(false)
  const [parsing, setParsing]   = useState(false)
  const [saving, setSaving]     = useState(false)
  // Ошибки — уведомлением, а не плашкой над формой: выписку размечают внизу
  // длинного списка, и плашка вверху страницы оставалась за краем экрана
  const setError = (msg) => { if (msg) toast.error(msg) }

  // Данные из парсера
  const [header, setHeader]         = useState(null)
  const [rows, setRows]             = useState([])
  const [projects, setProjects]     = useState([])
  const [stats, setStats]           = useState(null)

  // Шапка формы
  const [projectId, setProjectId]   = useState('')
  const [cashInfoId, setCashInfoId] = useState('')
  const [cashInfoList, setCashInfoList] = useState([])

  // Балансовые счета и справочники
  const [balanceItems, setBalanceItems] = useState([])
  const [infoCache, setInfoCache]       = useState({})

  // Карта операций для каждой строки: rowIdx -> [{amount, ...}]
  const [rowOpsMap, setRowOpsMap] = useState({})
  const [rowIgnoredMap, setRowIgnoredMap] = useState({})
  const [rowReadyMap, setRowReadyMap] = useState({})
  const [forcedIgnored, setForcedIgnored] = useState(null) // { value, nonce }

  // Массовое переключение выбора всех строк.
  const setAllIgnored = (value) => {
    setForcedIgnored({ value, nonce: Date.now() })
  }

  // ── ИИ-доразбор строк, которые не покрылись правилами ──────────────────────
  const [aiBusy, setAiBusy]       = useState(false)
  const [aiProgress, setAiProgress] = useState(null)   // { done, total }
  const [aiRules, setAiRules]     = useState([])       // предложенные правила
  const [aiDone, setAiDone]       = useState(0)        // сколько строк размечено
  const [aiError, setAiError]     = useState('')

  // Нераспознанное: категории нет или OTHER
  const unmatchedIdx = rows
    .map((r, i) => (!r.suggested_category || r.suggested_category === 'OTHER') ? i : -1)
    .filter(i => i >= 0)

  const runAi = async () => {
    if (!unmatchedIdx.length || aiBusy) return
    setAiBusy(true); setAiError(''); setAiRules([]); setAiDone(0)
    const CHUNK = 20
    let filled = 0
    const proposals = []
    try {
      for (let from = 0; from < unmatchedIdx.length; from += CHUNK) {
        const part = unmatchedIdx.slice(from, from + CHUNK)
        setAiProgress({ done: from, total: unmatchedIdx.length })
        const payload = part.map(i => ({
          direction:        rows[i].direction || null,
          amount:           rows[i].amount ?? null,
          counterparty_raw: rows[i].counterparty_raw || null,
          counterparty_inn: rows[i].counterparty_inn || null,
          purpose_raw:      rows[i].purpose_raw || null,
        }))
        const r = await classifyStatement(payload)
        const got = r.data.rows || {}
        // Ключ ответа — позиция внутри пачки, переводим в индекс строки выписки
        setRows(prev => prev.map((row, i) => {
          const pos = part.indexOf(i)
          if (pos < 0 || !got[pos]) return row
          filled++
          return { ...row, ...got[pos], _aiV: (row._aiV || 0) + 1 }
        }))
        ;(r.data.rules || []).forEach(x => proposals.push(x))
      }
      setAiDone(filled)
      // Дубли между пачками отсеиваем
      const seen = new Set()
      setAiRules(proposals.filter(x => {
        const k = `${x.direction}|${x.inn}|${x.purpose_keywords}|${x.category}`
        if (seen.has(k)) return false
        seen.add(k); return true
      }))
    } catch (e) {
      setAiError(e.response?.data?.message || 'Не удалось разобрать строки')
    } finally {
      setAiBusy(false); setAiProgress(null)
    }
  }

  const saveAiRules = async () => {
    if (!aiRules.length) return
    setAiBusy(true); setAiError('')
    try {
      const r = await applyRules(aiRules)
      setAiRules([])
      setAiDone(d => d)   // счётчик строк не трогаем
      toast.success(`Создано правил: ${r.data.created}. Дальше такие платежи распознаются автоматически.`)
    } catch (e) {
      setAiError(e.response?.data?.message || 'Не удалось создать правила')
    } finally { setAiBusy(false) }
  }

  /**
   * Перечитать один справочник.
   *
   * Нужна не только при первой загрузке: в строке выписки можно завести
   * контрагента прямо на месте, и остальные строки должны его увидеть — иначе
   * следующую операцию тому же поставщику придётся заводить заново.
   */
  const reloadInfo = useCallback((type) => {
    if (!type) return
    getInfo({ type })
      .then(r => setInfoCache(c => ({ ...c, [type]: r.data.data })))
      .catch(() => {})
  }, [])

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    // Загружаем счета и справочники
    getBalanceItems().then(r => setBalanceItems(r.data.data))
    getInfo({ type: 'cash' }).then(r => setCashInfoList(r.data.data))
    // Загружаем все типы аналитики которые могут встретиться в balance_items
    const infoTypes = ['flow', 'partner', 'employee', 'department', 'expenses', 'revenue', 'product', 'cash']
    infoTypes.forEach(type => reloadInfo(type))
  }, [])

  // ── Загрузка файла ──────────────────────────────────────────────────────────
  const handleFile = async (file) => {
    if (!file) return
    setParsing(true)
    setError('')
    try {
      const res = await parseBankStatement(file)
      const d   = res.data
      setHeader(d.header)
      setRows(d.rows)
      setProjects(d.projects)
      setStats(d.stats)
      setProjectId(d.projects[0]?.id || '')
      // Автозаполнение расчётного счёта
      if (d.cash_info_id) setCashInfoId(d.cash_info_id)
    } catch (e) {
      setError(e.response?.data?.message || 'Ошибка парсинга файла')
    } finally {
      setParsing(false)
    }
  }

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const onFileInput = (e) => {
    const file = e.target.files[0]
    if (file) handleFile(file)
  }

  // ── Создать операции для одной строки (используется при пересоздании) ─────────
  const createOperationsForRow = async (row, ops) => {
    const a100 = balanceItems.find(b => b.code === 'А100')
    for (const op of ops) {
      const payload = {
        date:          row.doc_date,
        project_id:    projectId,
        amount:        parseFloat(op.amount),
        source:        'bank_import',
        external_id:   row.external_id,
        external_date: row.external_date,
        note:          row.note,
        content:       row.purpose_raw || '',
        in_bi_id:      op.in_bi_id,
        out_bi_id:     op.out_bi_id,
        in_info_1_id:  op.in_info_1_id || null,
        in_info_2_id:  op.in_info_2_id || null,
        out_info_1_id: op.out_info_1_id || null,
        out_info_2_id: op.out_info_2_id || null,
      }
      if (op._kind !== 'fee') {
        if (row.direction === 'in') {
          payload.in_bi_id     = a100?.id
          payload.in_info_1_id = parseInt(cashInfoId) || null
        } else {
          payload.out_bi_id    = a100?.id
          payload.out_info_1_id = parseInt(cashInfoId) || null
        }
      }
      await createOperation(payload)
    }
  }

  // ── Подсчёт готовых строк ───────────────────────────────────────────────────
  const a100 = balanceItems.find(b => b.code === 'А100')

  // Готовность строки определяет сама StatementRow (учитывает свод, ноги комиссии
  // и т.д.) и сообщает через rowReadyMap — здесь логику не дублируем.
  const readyRows = rows.filter((row, idx) => rowReadyMap[idx])

  // ── Создать операции ────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!projectId) { setError('Выберите проект'); return }
    if (!cashInfoId) { setError('Выберите расчётный счёт'); return }
    if (!readyRows.length) { setError('Нет строк готовых к созданию'); return }

    const go = await confirm({
      title: `Создать операции: ${readyRows.length}?`,
      text: `Строк без разметки: ${rows.length - readyRows.length - rows.filter(r => r.existing_operation_ids?.length).length} — они останутся в выписке.`,
      confirmLabel: 'Создать',
    })
    if (!go) return

    setSaving(true)
    setError('')

    try {
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx]
        if (!rowReadyMap[idx]) continue          // создаём только готовые и выбранные
        if (row.existing_operation_ids?.length > 0) continue

        const ops = rowOpsMap[idx] || []

        for (const op of ops) {
          if (op._kind === 'fee') {
            // Нога комиссии: обе стороны заданы, А100 не навязываем.
            if (!op.in_bi_id || !op.out_bi_id) continue
          } else {
            const hasFlow    = row.direction === 'in' ? op.in_info_2_id : op.out_info_2_id
            const hasCounter = row.direction === 'in' ? op.out_bi_id : op.in_bi_id
            if (!hasFlow || !hasCounter) continue
          }

          // Устанавливаем А100 и cash_info_id в нужные слоты
          const payload = {
            date:          row.doc_date,
            project_id:    projectId,
            amount:        parseFloat(op.amount),
            source:        'bank_import',
            external_id:   row.external_id,
            external_date: row.external_date,
            note:          row.note,
            content:       row.purpose_raw || '',  
            in_bi_id:      op.in_bi_id,
            out_bi_id:     op.out_bi_id,
            in_info_1_id:  op.in_info_1_id || null,
            in_info_2_id:  op.in_info_2_id || null,
            out_info_1_id: op.out_info_1_id || null,
            out_info_2_id: op.out_info_2_id || null,
          }

          // Проставляем cash_info_id на сторону А100 (кроме ноги комиссии)
          if (op._kind !== 'fee') {
            if (row.direction === 'in') {
              payload.in_bi_id    = a100?.id
              payload.in_info_1_id = parseInt(cashInfoId) || null
            } else {
              payload.out_bi_id    = a100?.id
              payload.out_info_1_id = parseInt(cashInfoId) || null
            }
          }

          await createOperation(payload)
        }
      }

      toast.success('Операции созданы')
      navigate('/operations')
    } catch (e) {
      setError(e.response?.data?.message || 'Ошибка при создании операций')
    } finally {
      setSaving(false)
    }
  }

  const ic = 'h-9 px-3 border border-gray-200 rounded-lg text-sm bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500'

  return (
    <Layout>
      <PageHeader title="Банковская выписка"
        subtitle="Загрузите файл выписки из банка — строки станут операциями. Формат 1С: ClientBankExchange, .txt" />

      {/* ── Шапка формы ── */}
      <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-5 mb-5">
        <div className={`grid grid-cols-2 gap-4 ${header ? 'mb-4' : ''}`}>
          {/* Загрузка файла */}
          <div
            className={`col-span-2 border-2 border-dashed rounded-xl text-center cursor-pointer transition-colors ${
              header ? 'px-5 py-3' : 'px-6 py-10'
            } ${dragging ? 'border-brand-400 bg-brand-50' : 'border-gray-200 hover:border-brand-300 hover:bg-gray-50'}`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById('bank-file-input').click()}
          >
            <input id="bank-file-input" type="file" accept=".txt" className="hidden" onChange={onFileInput} />
            {parsing ? (
              <div className="text-brand-700 text-sm">Читаю файл…</div>
            ) : header ? (
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-gray-600">
                <FileUp className="w-4 h-4 text-gray-400" aria-hidden="true" />
                <span className="font-medium text-gray-900">{header.bank_name}</span>
                <span>счёт <span className="font-mono">{header.account_number}</span></span>
                <span className="tabular-nums">{fmtDate(header.date_from)} — {fmtDate(header.date_to)}</span>
                <span className="text-xs text-brand-700">Заменить файл</span>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className="w-12 h-12 mb-3 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center">
                  <FileUp className="w-6 h-6" aria-hidden="true" />
                </div>
                <div className="text-sm font-medium text-gray-800">Перетащите файл выписки сюда</div>
                <div className="mt-1 text-sm text-gray-500">или нажмите, чтобы выбрать на компьютере</div>
                <div className="mt-3 text-xs text-gray-500 max-w-md">
                  В интернет-банке выберите «Экспорт в 1С» — получится файл .txt. Операции появятся только после проверки и нажатия «Создать».
                </div>
              </div>
            )}
          </div>
        </div>

        {header && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Расчётный счёт */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Расчётный счёт</label>
              <select
                className={ic + ' w-full'}
                value={cashInfoId}
                onChange={e => setCashInfoId(e.target.value)}
              >
                <option value="">— Выбрать —</option>
                {cashInfoList.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* Проект */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Проект</label>
              <select
                className={ic + ' w-full'}
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
              >
                <option value="">— Выбрать —</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Остатки */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Остаток на начало</label>
              <div className="h-9 flex items-center px-3 bg-gray-50 rounded-lg text-sm tabular-nums text-gray-800">
                {fmt(header.opening_balance)}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Остаток на конец</label>
              <div className="h-9 flex items-center px-3 bg-gray-50 rounded-lg text-sm tabular-nums text-gray-800">
                {fmt(header.closing_balance)}
              </div>
            </div>
          </div>
        )}

        {/* Статистика */}
        {stats && (
          <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-gray-100">
            <Badge tone="gray">Строк в файле · {stats.total}</Badge>
            <Badge tone="brand">Распознано правилами · {stats.matched}</Badge>
            {stats.existing > 0 && <Badge tone="green">Уже загружено раньше · {stats.existing}</Badge>}
            {stats.total - stats.matched - stats.existing > 0 && (
              <Badge tone="amber">Нужно разметить · {stats.total - stats.matched - stats.existing}</Badge>
            )}
          </div>
        )}
      </div>

      {/* ── Таблица строк ── */}
      {rows.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-gray-800">Строки выписки · {rows.length}</h2>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setAllIgnored(true)} title="Пропустить все строки">Пропустить все</Button>
              <Button size="sm" variant="ghost" onClick={() => setAllIgnored(false)} title="Вернуть все строки к разметке">Вернуть все</Button>
            </div>
          </div>

          {/* ── ИИ: доразбор нераспознанного + предложения правил ── */}
          {(unmatchedIdx.length > 0 || aiRules.length > 0 || aiDone > 0) && (
            <div className="mb-3 rounded-xl border border-brand-200 bg-brand-50/60 p-3.5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm text-gray-700">
                  {unmatchedIdx.length > 0 ? (
                    <>Правила не распознали <b>{unmatchedIdx.length}</b> {unmatchedIdx.length === 1 ? 'строку' : 'строк'}</>
                  ) : (
                    <>Все строки распознаны</>
                  )}
                  {aiDone > 0 && <span className="text-green-700"> · ИИ разметил {aiDone}</span>}
                </div>
                {unmatchedIdx.length > 0 && (
                  <Button size="sm" variant="primary" icon={Sparkles} loading={aiBusy} onClick={runAi}>
                    {aiBusy
                      ? (aiProgress ? `Разбираю… ${aiProgress.done} из ${aiProgress.total}` : 'Разбираю…')
                      : `Разобрать с помощью ИИ · ${unmatchedIdx.length}`}
                  </Button>
                )}
              </div>

              {aiError && <p className="text-xs text-red-600 mt-2">{aiError}</p>}

              {aiRules.length > 0 && (
                <div className="mt-3 pt-3 border-t border-brand-200">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-xs font-medium text-brand-800">
                      Закрепить правилами ({aiRules.length}) — дальше такие платежи распознаются бесплатно:
                    </p>
                    <Button size="sm" disabled={aiBusy} onClick={saveAiRules}>Создать правила</Button>
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {aiRules.map((r, k) => (
                      <div key={k} className="flex items-start justify-between gap-2 text-xs">
                        <span className="text-gray-700">
                          <span className="text-gray-400">[{r.direction}]</span>{' '}
                          {r.inn && <span className="font-mono">ИНН {r.inn} </span>}
                          {r.purpose_keywords && <>«{r.purpose_keywords}» </>}
                          <span className="text-gray-400">→</span> <b>{r.category}</b>
                          {r.reason && <span className="block text-gray-400">{r.reason}</span>}
                        </span>
                        <IconButton icon={X} size="xs" variant="danger" label="Не создавать это правило"
                          onClick={() => setAiRules(list => list.filter((_, j) => j !== k))} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {rows.map((row, idx) => (
            <StatementRow
              key={`${idx}:${row._aiV || 0}`}
              row={row}
              projectId={projectId}
              cashInfoId={cashInfoId}
              balanceItems={balanceItems}
              infoCache={infoCache}
              onInfoCreated={reloadInfo}
              direction={row.direction}
              forcedIgnored={forcedIgnored}
              onOperationsChange={async (ops, ignored, shouldCreate, readyForCreate) => {
                setRowOpsMap(m => ({ ...m, [idx]: ops }))
                setRowIgnoredMap(m => ({ ...m, [idx]: ignored }))
                setRowReadyMap(m => ({ ...m, [idx]: !!readyForCreate }))
                if (shouldCreate) {
                  try {
                    await createOperationsForRow(row, ops)
                  } catch(e) {
                    setError('Ошибка при создании: ' + (e.response?.data?.message || e.message))
                  }
                }
              }}
            />
          ))}

          {/* Итог и главное действие — прилипают к низу экрана. Раньше кнопка
              «Создать» жила в шапке страницы: разметив строки внизу списка,
              за ней приходилось прокручивать наверх */}
          <div className="sticky bottom-0 z-10 -mx-4 md:-mx-6 mt-4 px-4 md:px-6 py-3 bg-white/90 backdrop-blur border-t border-gray-200">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-gray-600">
                Готово к созданию: <span className="font-semibold text-gray-900 tabular-nums">{readyRows.length}</span> из {rows.length}
                {(!projectId || !cashInfoId) && (
                  <span className="ml-2 text-amber-700">· выберите {!cashInfoId ? 'расчётный счёт' : 'проект'} вверху</span>
                )}
              </div>
              <Button variant="primary" icon={Check} loading={saving}
                disabled={!readyRows.length || !projectId || !cashInfoId}
                onClick={handleCreate}>
                Создать операции{readyRows.length ? ` · ${readyRows.length}` : ''}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}