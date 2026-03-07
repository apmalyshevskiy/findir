import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { parseBankStatement } from '../api/bankStatements'
import { createOperation, updateOperation, deleteOperation, getOperations } from '../api/operations'
import { getInfo } from '../api/info'
import { getBalanceItems } from '../api/operations'
import Layout from '../components/Layout'

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n) => n == null ? '—' : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const buildTree = (items) => {
  const map = {}
  const roots = []
  items.forEach(i => { map[i.id] = { ...i, children: [] } })
  items.forEach(i => {
    if (i.parent_id && map[i.parent_id]) map[i.parent_id].children.push(map[i.id])
    else roots.push(map[i.id])
  })
  const sort = (nodes) => {
    nodes.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''))
    nodes.forEach(n => sort(n.children))
  }
  sort(roots)
  return roots
}

const flattenTree = (nodes, depth = 0) => {
  let r = []
  nodes.forEach(n => {
    r.push({ ...n, depth })
    if (n.children?.length) r = r.concat(flattenTree(n.children, depth + 1))
  })
  return r
}

// ── Компонент: поиск с иерархией (dropdown через portal) ────────────────────────
const InfoSelect = ({ items = [], value, onChange, placeholder = 'Выбрать...' }) => {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 200 })
  const inputRef = useRef()
  const dropRef = useRef()

  useEffect(() => {
    const handler = (e) => {
      if (
        inputRef.current && !inputRef.current.contains(e.target) &&
        !(dropRef.current && dropRef.current.contains(e.target))
      ) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleFocus = () => {
    const rect = inputRef.current.getBoundingClientRect()
    setDropPos({
      top:   rect.bottom + window.scrollY + 2,
      left:  rect.left   + window.scrollX,
      width: Math.max(rect.width, 260),
    })
    setOpen(true)
    setSearch('')
  }

  const flat = flattenTree(buildTree(items))
  const filtered = search
    ? flat.filter(i => i.name.toLowerCase().includes(search.toLowerCase()) || (i.code || '').toLowerCase().includes(search.toLowerCase()))
    : flat
  const selected = items.find(i => i.id == value)

  const dropdown = open && createPortal(
    <div
      ref={dropRef}
      style={{ position: 'absolute', top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}
      className="bg-white border border-gray-200 rounded-lg shadow-2xl max-h-60 overflow-y-auto"
    >
      <div
        className="px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer border-b border-gray-100"
        onMouseDown={() => { onChange(null); setOpen(false); setSearch('') }}
      >
        — Не выбрано
      </div>
      {filtered.map(i => (
        <div
          key={i.id}
          onMouseDown={() => { onChange(i.id); setOpen(false); setSearch('') }}
          className="px-3 py-1.5 text-xs hover:bg-blue-50 cursor-pointer"
          style={{ paddingLeft: `${12 + i.depth * 12}px` }}
        >
          {i.depth > 0 && <span className="text-gray-300 mr-1">└</span>}
          {i.code && <span className="text-gray-400 mr-1.5 font-mono">{i.code}</span>}
          {i.name}
        </div>
      ))}
      {filtered.length === 0 && (
        <div className="px-3 py-2 text-xs text-gray-400">Ничего не найдено</div>
      )}
    </div>,
    document.body
  )

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
        placeholder={selected ? selected.name : placeholder}
        value={open ? search : (selected?.name || '')}
        onFocus={handleFocus}
        onChange={e => setSearch(e.target.value)}
      />
      {dropdown}
    </div>
  )
}

// ── Строка операции внутри строки выписки ─────────────────────────────────────
const OperationLine = ({ op, totalAmount, isOnly, balanceItems, infoCache, direction, counterpartyInn, onChange, onRemove }) => {
  const ic = 'w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400'

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

  const INFO_LABELS = {
    partner: 'Контрагент', employee: 'Сотрудник', department: 'Отдел',
    cash: 'Счёт', flow: 'Статья ДДС', expenses: 'Статья расхода',
    product: 'Товар/Услуга', revenue: 'Статья дохода',
  }

  // Когда меняем корреспондирующий счёт — сбрасываем аналитику
  // и пробуем подобрать партнёра по ИНН если info_1_type = partner
  const handleCounterBiChange = (biId) => {
    const newBi = balanceItems.find(b => b.id == biId)
    let autoInfo1 = null

    // Автоподбор: если тип аналитики = partner и есть ИНН из выписки
    if (newBi?.info_1_type === 'partner' && counterpartyInn) {
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
          <div className="text-[10px] text-gray-400 mb-0.5">Сумма</div>
          <input
            type="number" step="0.01"
            className={ic + (Math.abs(op.amount || 0) > totalAmount ? ' border-red-400' : '')}
            value={op.amount || ''}
            onChange={e => onChange({ ...op, amount: parseFloat(e.target.value) || 0 })}
          />
        </div>

        {/* А100 — фиксированная наша сторона */}
        <div>
          <div className="text-[10px] text-gray-400 mb-0.5">
            {direction === 'in' ? 'Счёт Дт' : 'Счёт Кт'} (А100)
          </div>
          <div className="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded border border-blue-100 truncate">
            {a100 ? `${a100.code} ДЕНЕЖНЫЕ СРЕДСТВА` : 'А100'}
          </div>
        </div>

        {/* Статья ДДС — info_2 стороны А100 */}
        {a100Info2Type && (
          <div>
            <div className="text-[10px] text-gray-400 mb-0.5">{INFO_LABELS[a100Info2Type] || a100Info2Type}</div>
            <InfoSelect
              items={infoCache[a100Info2Type] || []}
              value={op[a100Info2Field]}
              onChange={v => onChange({ ...op, [a100Info2Field]: v })}
              placeholder="Выбрать..."
            />
          </div>
        )}

        {/* Удалить */}
        <div className="flex items-end justify-center">
          {!isOnly && (
            <button onClick={onRemove}
              className="text-gray-300 hover:text-red-500 transition-colors text-base leading-none pb-1"
              title="Удалить операцию">×</button>
          )}
        </div>
      </div>

      {/* Корреспондирующий счёт + его аналитика */}
      <div className="grid gap-x-2" style={{ gridTemplateColumns: counterInfo1Type ? (counterInfo2Type ? '1fr 1fr 1fr' : '1fr 1fr') : '1fr' }}>

        {/* Корреспондирующий счёт */}
        <div>
          <div className="text-[10px] text-gray-400 mb-0.5">
            {direction === 'in' ? 'Счёт Кт' : 'Счёт Дт'}
          </div>
          <select
            className={ic}
            value={op[counterBiField] || ''}
            onChange={e => handleCounterBiChange(parseInt(e.target.value) || null)}
          >
            <option value="">— Выбрать счёт —</option>
            {balanceItems.filter(b => b.code !== 'А100').map(b => (
              <option key={b.id} value={b.id}>{b.code} {b.name.replace(/^[А-ЯA-Z]\d+\s/, '')}</option>
            ))}
          </select>
        </div>

        {/* Аналитика 1 корреспондирующего счёта */}
        {counterInfo1Type && (
          <div>
            <div className="text-[10px] text-gray-400 mb-0.5">
              {INFO_LABELS[counterInfo1Type] || counterInfo1Type}
              {/* Подсказка если ИНН есть но партнёр не найден */}
              {counterInfo1Type === 'partner' && counterpartyInn && !op[counterInfo1Field] && (
                <span className="ml-1 text-amber-500" title={`ИНН ${counterpartyInn} не найден в справочнике`}>⚠</span>
              )}
              {counterInfo1Type === 'partner' && counterpartyInn && op[counterInfo1Field] && (
                <span className="ml-1 text-emerald-500" title={`Найден по ИНН ${counterpartyInn}`}>✓</span>
              )}
            </div>
            <InfoSelect
              items={infoCache[counterInfo1Type] || []}
              value={op[counterInfo1Field]}
              onChange={v => onChange({ ...op, [counterInfo1Field]: v })}
              placeholder={counterInfo1Type === 'partner' && counterpartyInn ? `ИНН ${counterpartyInn}...` : 'Выбрать...'}
            />
          </div>
        )}

        {/* Аналитика 2 корреспондирующего счёта */}
        {counterInfo2Type && (
          <div>
            <div className="text-[10px] text-gray-400 mb-0.5">{INFO_LABELS[counterInfo2Type] || counterInfo2Type}</div>
            <InfoSelect
              items={infoCache[counterInfo2Type] || []}
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
const StatementRow = ({ row, projectId, cashInfoId, balanceItems, infoCache, onOperationsChange }) => {
  const a100 = balanceItems.find(b => b.code === 'А100')
  const a100Id = a100?.id

  const makeDefaultOp = () => {
    const op = { amount: row.amount }
    if (row.direction === 'in') {
      op.in_bi_id     = a100Id || null
      op.in_info_1_id = cashInfoId || null
      op.in_info_2_id = row.suggested_flow_id || null
      op.out_bi_id    = null
      op.out_info_1_id = row.suggested_partner_id || null
    } else {
      op.out_bi_id     = a100Id || null
      op.out_info_1_id = cashInfoId || null
      op.out_info_2_id = row.suggested_flow_id || null
      op.in_bi_id      = null
      op.in_info_1_id  = row.suggested_partner_id || null
    }
    return op
  }

  const [ops, setOps] = useState([makeDefaultOp()])
  const [expanded, setExpanded] = useState(false)
  const [ignored, setIgnored] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [loadingOps, setLoadingOps] = useState(false)
  const [savedOps, setSavedOps] = useState(null) // снимок для отмены
  // Локальный список уже созданных id (можно обновить после пересоздания)
  const [postedIds, setPostedIds] = useState(row.existing_operation_ids || [])

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

  // Синхронизируем операции вверх
  useEffect(() => {
    onOperationsChange(ops, ignored)
  }, [ops, ignored])

  const distributed = ops.reduce((s, o) => s + (parseFloat(o.amount) || 0), 0)
  const remainder   = Math.round((row.amount - distributed) * 100) / 100

  const isPosted  = postedIds.length > 0
  // isReady — заполнены все обязательные поля (не зависит от isPosted)
  const isReady = !ignored && ops.every(op => {
    const hasFlow    = row.direction === 'in' ? op.in_info_2_id : op.out_info_2_id
    const hasCounter = row.direction === 'in' ? op.out_bi_id : op.in_bi_id
    return hasFlow && hasCounter && (parseFloat(op.amount) || 0) > 0
  }) && Math.abs(remainder) < 0.01
  // isMatched — для новых строк (не загруженных) — управляет статусом «✓ Готово»
  const isMatched = isReady && !isPosted

  const statusColor = isPosted
    ? 'bg-green-50 border-l-4 border-l-green-400'
    : ignored
    ? 'bg-gray-50 border-l-4 border-l-gray-300 opacity-60'
    : isMatched
    ? 'bg-emerald-50 border-l-4 border-l-emerald-400'
    : 'bg-white border-l-4 border-l-amber-400'

  return (
    <div className={`rounded-xl border border-gray-100 mb-2 overflow-hidden ${statusColor}`}>
      {/* Заголовок строки */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-black/5 transition-colors"
        onClick={() => !ignored && setExpanded(e => !e)}
      >
        {/* Направление */}
        <span className={`text-xs font-bold w-5 text-center ${row.direction === 'in' ? 'text-emerald-600' : 'text-red-500'}`}>
          {row.direction === 'in' ? '↑' : '↓'}
        </span>

        {/* Дата + тип документа */}
        <div className="w-32 shrink-0">
          <div className="text-xs text-gray-500">{row.doc_date}</div>
          <div className="text-[10px] text-gray-400">{row.doc_type?.replace('Платежное поручение', 'П/П') || ''} №{row.doc_number}</div>
        </div>

        {/* Сумма */}
        <div className={`w-28 shrink-0 text-sm font-semibold tabular-nums ${row.direction === 'in' ? 'text-emerald-700' : 'text-red-600'}`}>
          {row.direction === 'in' ? '+' : '−'}{fmt(row.amount)}
        </div>

        {/* Контрагент */}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-gray-700 truncate">{row.counterparty_raw || '—'}</div>
          <div className="text-[10px] text-gray-400 truncate">{row.purpose_raw || ''}</div>
        </div>

        {/* Статус */}
        <div className="w-36 shrink-0 text-right flex items-center justify-end gap-2">
          {isPosted ? (
            <>
              <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                🔗 Создано ({postedIds.length})
              </span>
              <button
                onClick={e => { e.stopPropagation(); loadAndExpand() }}
                disabled={loadingOps}
                className="text-[10px] text-orange-500 hover:text-orange-700 border border-orange-200 hover:border-orange-400 px-1.5 py-0.5 rounded transition-colors shrink-0 disabled:opacity-50"
                title="Скорректировать"
              >
                {loadingOps ? '...' : '✎ Изменить'}
              </button>
            </>
          ) : ignored ? (
            <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Пропущено</span>
          ) : isMatched ? (
            <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">✓ Готово</span>
          ) : (
            <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Не размечено</span>
          )}
        </div>

        {/* Кнопка игнорировать */}
        {!isPosted && (
          <button
            onClick={e => { e.stopPropagation(); setIgnored(v => !v) }}
            className="text-[10px] text-gray-400 hover:text-gray-600 shrink-0"
            title={ignored ? 'Восстановить' : 'Пропустить'}
          >
            {ignored ? '↩' : '⊘'}
          </button>
        )}

        {/* Стрелка раскрытия */}
        {(!isPosted || expanded) && !ignored && (
          <span className="text-gray-400 text-xs shrink-0" onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}>{expanded ? '▲' : '▼'}</span>
        )}
      </div>

      {/* Панель разметки */}
      {expanded && !ignored && (
        <div className="px-4 pb-3 space-y-2">
          {ops.map((op, idx) => (
            <OperationLine
              key={idx}
              op={op}
              totalAmount={row.amount}
              isOnly={ops.length === 1}
              balanceItems={balanceItems}
              infoCache={infoCache}
              direction={row.direction}
              counterpartyInn={row.counterparty_inn}
              onChange={v => setOps(ops.map((o, i) => i === idx ? v : o))}
              onRemove={() => setOps(ops.filter((_, i) => i !== idx))}
            />
          ))}

          {/* Счётчик распределения */}
          {ops.length > 1 && (
            <div className={`text-xs px-2 py-1 rounded ${Math.abs(remainder) < 0.01 ? 'text-emerald-700 bg-emerald-50' : 'text-amber-700 bg-amber-50'}`}>
              Распределено: {fmt(distributed)} из {fmt(row.amount)}
              {Math.abs(remainder) > 0.01 && ` · Остаток: ${fmt(remainder)}`}
            </div>
          )}

          {/* Кнопка «Разбить» */}
          <button
            onClick={() => setOps([...ops, { ...makeDefaultOp(), amount: Math.max(0, remainder) }])}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            <span>+</span> Добавить операцию (разбить)
          </button>

          {/* Кнопка сохранения изменений — перезаписываем существующие операции */}
          {isPosted && (
            <div className="pt-2 border-t border-gray-200 flex items-center justify-between gap-3">
              <span className="text-[10px] text-gray-400">
                Обновление {postedIds.length} операции(й) без удаления
              </span>
              <div className="flex gap-2">
              <button
                onClick={() => {
                  if (savedOps) setOps(savedOps)
                  setExpanded(false)
                }}
                className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 hover:border-gray-400 px-3 py-1.5 rounded-lg transition-colors"
              >
                Отмена
              </button>
              <button
                disabled={reloading || !isReady}
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
                        in_bi_id:      op.in_bi_id,
                        out_bi_id:     op.out_bi_id,
                        in_info_1_id:  op.in_info_1_id || null,
                        in_info_2_id:  op.in_info_2_id || null,
                        out_info_1_id: op.out_info_1_id || null,
                        out_info_2_id: op.out_info_2_id || null,
                      }
                      if (row.direction === 'in') {
                        base.in_bi_id     = a100?.id
                        base.in_info_1_id = parseInt(cashInfoId) || null
                      } else {
                        base.out_bi_id    = a100?.id
                        base.out_info_1_id = parseInt(cashInfoId) || null
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
                  } catch(e) {
                    alert('Ошибка: ' + (e.response?.data?.message || e.message))
                  } finally {
                    setReloading(false)
                  }
                }}
                className="text-xs bg-orange-500 text-white px-3 py-1.5 rounded-lg hover:bg-orange-600 disabled:opacity-40 transition-colors"
              >
                {reloading ? 'Сохраняем...' : '↻ Сохранить изменения'}
              </button>
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
  const [error, setError]       = useState('')

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

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    // Загружаем счета и справочники
    getBalanceItems().then(r => setBalanceItems(r.data.data))
    getInfo({ type: 'cash' }).then(r => setCashInfoList(r.data.data))
    // Загружаем все типы аналитики которые могут встретиться в balance_items
    const infoTypes = ['flow', 'partner', 'employee', 'department', 'expenses', 'revenue', 'product']
    infoTypes.forEach(type =>
      getInfo({ type }).then(r => setInfoCache(c => ({ ...c, [type]: r.data.data })))
    )
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
        in_bi_id:      op.in_bi_id,
        out_bi_id:     op.out_bi_id,
        in_info_1_id:  op.in_info_1_id || null,
        in_info_2_id:  op.in_info_2_id || null,
        out_info_1_id: op.out_info_1_id || null,
        out_info_2_id: op.out_info_2_id || null,
      }
      if (row.direction === 'in') {
        payload.in_bi_id     = a100?.id
        payload.in_info_1_id = parseInt(cashInfoId) || null
      } else {
        payload.out_bi_id    = a100?.id
        payload.out_info_1_id = parseInt(cashInfoId) || null
      }
      await createOperation(payload)
    }
  }

  // ── Подсчёт готовых строк ───────────────────────────────────────────────────
  const a100 = balanceItems.find(b => b.code === 'А100')

  const readyRows = rows.filter((row, idx) => {
    if (rowIgnoredMap[idx]) return false
    if (row.existing_operation_ids?.length > 0) return false
    const ops = rowOpsMap[idx] || []
    if (!ops.length) return false
    const distributed = ops.reduce((s, o) => s + (parseFloat(o.amount) || 0), 0)
    const remainder = Math.abs(row.amount - distributed)
    return remainder < 0.01 && ops.every(op => {
      const hasFlow    = row.direction === 'in' ? op.in_info_2_id : op.out_info_2_id
      const hasCounter = row.direction === 'in' ? op.out_bi_id : op.in_bi_id
      return hasFlow && hasCounter
    })
  })

  // ── Создать операции ────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!projectId) { setError('Выберите проект'); return }
    if (!cashInfoId) { setError('Выберите расчётный счёт'); return }
    if (!readyRows.length) { setError('Нет строк готовых к созданию'); return }

    const confirm = window.confirm(
      `Будет создано операций: ${readyRows.length}.\n` +
      `Строк без разметки: ${rows.length - readyRows.length - rows.filter(r => r.existing_operation_ids?.length).length}.\n\nПродолжить?`
    )
    if (!confirm) return

    setSaving(true)
    setError('')

    try {
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx]
        if (rowIgnoredMap[idx]) continue
        if (row.existing_operation_ids?.length > 0) continue

        const ops = rowOpsMap[idx] || []
        const distributed = ops.reduce((s, o) => s + (parseFloat(o.amount) || 0), 0)
        const remainder = Math.abs(row.amount - distributed)
        if (remainder >= 0.01) continue

        for (const op of ops) {
          const hasFlow    = row.direction === 'in' ? op.in_info_2_id : op.out_info_2_id
          const hasCounter = row.direction === 'in' ? op.out_bi_id : op.in_bi_id
          if (!hasFlow || !hasCounter) continue

          // Устанавливаем А100 и cash_info_id в нужные слоты
          const payload = {
            date:          row.doc_date,
            project_id:    projectId,
            amount:        parseFloat(op.amount),
            source:        'bank_import',
            external_id:   row.external_id,
            external_date: row.external_date,
            note:          row.note,
            in_bi_id:      op.in_bi_id,
            out_bi_id:     op.out_bi_id,
            in_info_1_id:  op.in_info_1_id || null,
            in_info_2_id:  op.in_info_2_id || null,
            out_info_1_id: op.out_info_1_id || null,
            out_info_2_id: op.out_info_2_id || null,
          }

          // Проставляем cash_info_id на сторону А100
          if (row.direction === 'in') {
            payload.in_bi_id    = a100?.id
            payload.in_info_1_id = parseInt(cashInfoId) || null
          } else {
            payload.out_bi_id    = a100?.id
            payload.out_info_1_id = parseInt(cashInfoId) || null
          }

          await createOperation(payload)
        }
      }

      alert('Операции успешно созданы!')
      navigate('/dashboard')
    } catch (e) {
      setError(e.response?.data?.message || 'Ошибка при создании операций')
    } finally {
      setSaving(false)
    }
  }

  const ic = 'px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <Layout>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Банковская выписка</h1>
          <p className="text-sm text-gray-500 mt-0.5">Загрузите TXT-файл формата 1C ClientBankExchange</p>
        </div>
        {readyRows.length > 0 && (
          <button
            onClick={handleCreate}
            disabled={saving || !projectId || !cashInfoId}
            className="bg-blue-900 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {saving ? 'Создаём...' : `Создать операции (${readyRows.length})`}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {/* ── Шапка формы ── */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
        <div className="grid grid-cols-2 gap-4 mb-4">
          {/* Загрузка файла */}
          <div
            className={`col-span-2 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
            }`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById('bank-file-input').click()}
          >
            <input id="bank-file-input" type="file" accept=".txt" className="hidden" onChange={onFileInput} />
            {parsing ? (
              <div className="text-blue-600 text-sm">Парсим файл...</div>
            ) : header ? (
              <div className="text-sm text-gray-600">
                <span className="font-medium text-gray-800">{header.bank_name}</span>
                {' · '}счёт {header.account_number}
                {' · '}{header.date_from} — {header.date_to}
                <span className="ml-3 text-xs text-gray-400">Нажмите для замены файла</span>
              </div>
            ) : (
              <div className="text-gray-400 text-sm">
                Перетащите TXT-файл сюда или нажмите для выбора
              </div>
            )}
          </div>
        </div>

        {header && (
          <div className="grid grid-cols-4 gap-4">
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
              <div className="px-3 py-2 bg-gray-50 rounded-lg text-sm font-mono text-gray-700">
                {fmt(header.opening_balance)}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Остаток на конец</label>
              <div className="px-3 py-2 bg-gray-50 rounded-lg text-sm font-mono text-gray-700">
                {fmt(header.closing_balance)}
              </div>
            </div>
          </div>
        )}

        {/* Статистика */}
        {stats && (
          <div className="flex gap-4 mt-4 pt-4 border-t border-gray-100">
            <span className="text-xs text-gray-500">Строк: <b>{stats.total}</b></span>
            <span className="text-xs text-emerald-600">Сопоставлено: <b>{stats.matched}</b></span>
            {stats.existing > 0 && (
              <span className="text-xs text-blue-600">Уже загружено: <b>{stats.existing}</b></span>
            )}
            <span className="text-xs text-amber-600">
              Требует разметки: <b>{stats.total - stats.matched - stats.existing}</b>
            </span>
          </div>
        )}
      </div>

      {/* ── Таблица строк ── */}
      {rows.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Строки выписки</h2>
            <div className="text-xs text-gray-400">
              Готово к созданию: <span className="font-medium text-emerald-600">{readyRows.length}</span> из {rows.length}
            </div>
          </div>

          {rows.map((row, idx) => (
            <StatementRow
              key={idx}
              row={row}
              projectId={projectId}
              cashInfoId={cashInfoId}
              balanceItems={balanceItems}
              infoCache={infoCache}
              direction={row.direction}
              onOperationsChange={async (ops, ignored, shouldCreate) => {
                setRowOpsMap(m => ({ ...m, [idx]: ops }))
                setRowIgnoredMap(m => ({ ...m, [idx]: ignored }))
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
        </div>
      )}
    </Layout>
  )
}
