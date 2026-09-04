import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation } from 'react-router-dom'
import api from '../api/client'
import { getDocuments, getDocument, createDocument, updateDocument,
         deleteDocument, postDocument, cancelDocument } from '../api/documents'
import { getBalanceItems } from '../api/operations'
import { getDocumentTypes } from '../api/documentTypes'
import { getInfo } from '../api/info'
import Layout from '../components/Layout'
import { SkeletonRows } from '../components/Busy'
import OperationChanges from '../components/OperationChanges'
import { INFO_LABELS } from '../utils/infoLabels'

// Расчёт себестоимости
const calculateCostApi = (data) => api.post('/documents/calculate-cost', data)

// ─── Константы ────────────────────────────────────────────────────────────────

// Вкладки строятся из справочника видов документов: вид — это данные, а не код

const STATUS_LABELS = {
  draft:     { label: 'Не проведён', cls: 'bg-amber-100 text-amber-700' },
  posted:    { label: 'Проведён',    cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Отменён',     cls: 'bg-red-100 text-red-600' },
}

const fmt = (n) => n == null ? '—' :
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const fmtDate = (d) => d ? new Date(d).toLocaleDateString('ru-RU') : '—'

// Локальная дата без смещения UTC — формат для datetime-local input
const today = () => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh  = String(d.getHours()).padStart(2, '0')
  const mm  = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day}T${hh}:${mm}`
}

// Форматирование числа с разделением на триады для отображения
const fmtNum = (val) => {
  if (val === '' || val == null) return ''
  const n = parseFloat(String(val).replace(/\s/g, '').replace(',', '.'))
  if (isNaN(n)) return val
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(n)
}

// ─── Утилиты дерева ───────────────────────────────────────────────────────────

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

// ─── InfoSelect — дропдаун с поиском через portal ─────────────────────────────

// ─── NumInput — числовое поле с форматированием триадами ──────────────────────

const NumInput = ({ value, onChange, disabled, placeholder = '—', step = '0.01', className = '' }) => {
  const [focused, setFocused] = useState(false)

  // При редактировании показываем чистое число (точка как разделитель)
  const rawVal = value === '' || value == null ? '' : String(value).replace(',', '.')

  // В отображении — форматируем с триадами
  const displayVal = focused ? rawVal : fmtNum(value)

  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      disabled={disabled}
      placeholder={placeholder}
      value={displayVal}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={e => {
        // Разрешаем только цифры, точку, запятую и минус
        const v = e.target.value.replace(',', '.')
        if (v === '' || v === '-' || /^-?\d*\.?\d*$/.test(v)) {
          onChange(v)
        }
      }}
    />
  )
}

// ─── InfoSelect — дропдаун с поиском через portal ─────────────────────────────

const InfoSelect = ({ items = [], value, onChange, placeholder = 'Выбрать...', disabled }) => {
  const [search, setSearch]   = useState('')
  const [open, setOpen]       = useState(false)
  const [pos, setPos]         = useState({ top: 0, left: 0, width: 200 })
  const inputRef = useRef()
  const dropRef  = useRef()

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
    const r = inputRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + window.scrollY + 2, left: r.left + window.scrollX, width: Math.max(r.width, 240) })
    setOpen(true)
    setSearch('')
  }

  const flat     = flattenTree(buildTree(items))
  const filtered = search
    ? flat.filter(i => i.name.toLowerCase().includes(search.toLowerCase()) || (i.code || '').toLowerCase().includes(search.toLowerCase()))
    : flat
  const selected = items.find(i => i.id == value)

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        disabled={disabled}
        className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${disabled ? 'bg-gray-50 text-gray-400 cursor-not-allowed' : 'bg-white border-gray-200'}`}
        placeholder={selected ? selected.name : placeholder}
        value={open ? search : (selected ? selected.name : '')}
        onFocus={handleFocus}
        onChange={e => setSearch(e.target.value)}
      />
      {value && !disabled && (
        <button onClick={() => { onChange(null); setSearch('') }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 text-xs">✕</button>
      )}
      {open && createPortal(
        <div ref={dropRef} className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-xl max-h-60 overflow-y-auto"
          style={{ top: pos.top, left: pos.left, width: pos.width }}>
          {filtered.length === 0
            ? <div className="px-3 py-2 text-xs text-gray-400">Ничего не найдено</div>
            : filtered.map(i => (
              <div key={i.id}
                className="px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 flex items-center gap-1"
                style={{ paddingLeft: 12 + i.depth * 14 }}
                onMouseDown={() => { onChange(i.id); setOpen(false); setSearch('') }}>
                {i.depth > 0 && <span className="text-gray-300 text-xs">└</span>}
                <span className={i.depth === 0 ? 'font-medium text-gray-800' : 'text-gray-600'}>{i.name}</span>
                {i.code && <span className="ml-auto text-xs text-gray-400 font-mono">{i.code}</span>}
              </div>
            ))
          }
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── BiSelect — выбор счёта из balance_items ──────────────────────────────────

const BiSelect = ({ items = [], value, onChange, disabled, placeholder = 'Выбрать счёт...' }) => {
  const [search, setSearch] = useState('')
  const [open, setOpen]     = useState(false)
  const [pos, setPos]       = useState({ top: 0, left: 0, width: 200 })
  const inputRef = useRef()
  const dropRef  = useRef()

  useEffect(() => {
    const handler = (e) => {
      if (inputRef.current && !inputRef.current.contains(e.target) &&
        !(dropRef.current && dropRef.current.contains(e.target))) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleFocus = () => {
    const r = inputRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + window.scrollY + 2, left: r.left + window.scrollX, width: Math.max(r.width, 280) })
    setOpen(true)
    setSearch('')
  }

  const filtered = search
    ? items.filter(i => i.name.toLowerCase().includes(search.toLowerCase()) || i.code.toLowerCase().includes(search.toLowerCase()))
    : items
  const selected = items.find(i => i.id == value)

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        disabled={disabled}
        className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${disabled ? 'bg-gray-50 text-gray-400 cursor-not-allowed' : 'bg-white border-gray-200'}`}
        placeholder={selected ? `${selected.code} ${selected.name}` : placeholder}
        value={open ? search : (selected ? `${selected.code} ${selected.name}` : '')}
        onFocus={handleFocus}
        onChange={e => setSearch(e.target.value)}
      />
      {open && createPortal(
        <div ref={dropRef} className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-xl max-h-64 overflow-y-auto"
          style={{ top: pos.top, left: pos.left, width: pos.width }}>
          {filtered.length === 0
            ? <div className="px-3 py-2 text-xs text-gray-400">Ничего не найдено</div>
            : filtered.map(i => (
              <div key={i.id}
                className="px-3 py-2 text-sm cursor-pointer hover:bg-blue-50 flex items-center gap-2"
                onMouseDown={() => { onChange(i.id); setOpen(false); setSearch('') }}>
                <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">{i.code}</span>
                <span className="text-gray-700">{i.name}</span>
              </div>
            ))
          }
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── Форма документа ──────────────────────────────────────────────────────────

// Счета выручки и себестоимости нужны только расходной накладной: у неё
// собственный движок проведения, и эти два счёта не про шапку и строки
const OUTGOING_BI = { revenue: 'П587', cogs: 'П588' }

const findBiId = (balanceItems, code) =>
  balanceItems.find(b => b.code === code)?.id ?? ''

/**
 * Пустой документ выбранного вида.
 *
 * Счета берутся из справочника видов: он и решает, что стоит в шапке и в
 * строках. В самом документе их можно сменить — вид лишь подставляет начальное
 * значение.
 */
const emptyDoc = (type, balanceItems = []) => {
  const isOutgoing = type?.engine === 'outgoing_invoice'
  return {
    date: today(), number: '', external_number: '', external_date: '',
    project_id: 1, type: type?.code || '',
    bi_id:          type?.head_bi_id || '',
    info_1_id: null, info_2_id: null, info_3_id: null,
    revenue_bi_id:   isOutgoing ? findBiId(balanceItems, OUTGOING_BI.revenue) || null : null,
    cogs_bi_id:      isOutgoing ? findBiId(balanceItems, OUTGOING_BI.cogs)    || null : null,
    revenue_item_id: null,
    note: '', items: [],
  }
}

const emptyItem = (type) => ({
  _key: Math.random(),
  bi_id:      type?.item_bi_id || '',
  info_1_id: null, info_2_id: null, info_3_id: null,
  // Корреспондирующая сторона: пусто — значит «как в шапке»
  head_bi_id: null, head_info_1_id: null, head_info_2_id: null, head_info_3_id: null,
  quantity: '', price: '', amount: '', amount_vat: '', amount_cost: '',
  note: '',
})

/**
 * Форма документа.
 *
 * `type` — строка справочника видов: из неё берутся счета по умолчанию, сторона
 * шапки и набор колонок. Форму открывают и со стороны отчётов, где под рукой
 * только код вида (`docType`), — тогда она подтягивает вид сама.
 */
export function DocumentForm({ docType, type: typeProp, doc: docProp, balanceItems, infoCache, loadInfo, onSave, onCancel, onChanged }) {
  // Сохранение и проведение бывают «остаться в форме»: тогда форма живёт
  // дальше с документом, который вернул сервер, а проп остаётся позади.
  // Родителю о каждом таком шаге сообщает onChanged — он перечитывает свои
  // списки, не закрывая окна
  const [savedDoc, setSavedDoc] = useState(null)
  const doc      = savedDoc || docProp
  const isEdit   = !!doc
  const isPosted = doc?.status === 'posted'

  const [type, setType] = useState(typeProp || null)
  const [tab, setTab]   = useState('fields')   // 'fields' | 'changes'

  useEffect(() => {
    if (typeProp) { setType(typeProp); return }
    if (!docType) return
    getDocumentTypes()
      .then(r => setType((r.data.data || []).find(t => t.code === docType) || null))
      .catch(() => {})
  }, [typeProp, docType])

  const isOutgoing = type?.engine === 'outgoing_invoice'
  const headSide   = type?.head_side || 'credit'
  // Пока вид не приехал, колонки показываем: пустая таблица пугает сильнее лишнего столбца
  const showQty    = type ? type.show_quantity : true
  const showPrice  = type ? type.show_price    : true
  const showVat    = type ? type.show_vat      : true

  const [form, setForm]     = useState(() => {
    if (doc) {
      // Конвертируем дату из Y-m-d H:i:s в формат datetime-local (Y-m-dTH:i)
      const toDatetimeLocal = (str) => {
        if (!str) return today()
        return str.length === 10 ? str + 'T00:00' : str.slice(0, 16).replace(' ', 'T')
      }
      return {
        date: toDatetimeLocal(doc.date), number: doc.number || '',
        external_number: doc.external_number || '', external_date: doc.external_date || '',
        project_id: doc.project_id || 1, type: docType,
        bi_id: doc.bi_id || '', info_1_id: doc.info_1_id || null,
        info_2_id: doc.info_2_id || null, info_3_id: doc.info_3_id || null,
        revenue_bi_id: doc.revenue_bi_id || null, cogs_bi_id: doc.cogs_bi_id || null,
        revenue_item_id: doc.revenue_item_id || null,
        note: doc.note || '',
        items: (doc.items || []).map(i => ({
          _key: Math.random(), ...i,
          quantity: i.quantity ?? '', price: i.price ?? '',
          amount: i.amount ?? '', amount_vat: i.amount_vat ?? '',
          amount_cost: i.amount_cost ?? '',
        })),
      }
    }
    return emptyDoc(typeProp, balanceItems)
  })

  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const [costCalcLoading, setCostCalcLoading] = useState(false)
  const [costWarnings, setCostWarnings]       = useState([]) // строки с отрицательным остатком

  // Рассчитать себестоимость для всех строк без amount_cost (или для всех)
  const calcCost = async (forceAll = false) => {
    if (!isOutgoing) return
    const itemsToCalc = form.items.filter(i =>
      i.bi_id && (forceAll || !i.amount_cost || parseFloat(i.amount_cost) === 0)
    )
    if (itemsToCalc.length === 0) return

    setCostCalcLoading(true)
    setCostWarnings([])
    try {
      const res = await calculateCostApi({
        date:       form.date,
        project_id: form.project_id,
        items: itemsToCalc.map(i => ({
          bi_id:     i.bi_id,
          info_1_id: i.info_1_id || null,
          info_2_id: i.info_2_id || null,
          info_3_id: i.info_3_id || null,
          quantity:  parseFloat(i.quantity) || 0,
        }))
      })

      const results  = res.data.data      // массив результатов в том же порядке
      const warnings = []

      setForm(f => ({
        ...f,
        items: f.items.map(item => {
          // Ищем соответствующий результат по позиции среди отфильтрованных
          const idx = itemsToCalc.findIndex(ic => ic._key === item._key)
          if (idx === -1) return item
          const cost = results[idx]
          if (!cost) return item
          if (cost.negative_stock) {
            warnings.push({
              _key: item._key,
              name: (infoCache[balanceItems.find(b => b.id == item.bi_id)?.info_1_type] || [])
                      .find(x => x.id == item.info_1_id)?.name || `#${item.info_1_id}`,
            })
          }
          return { ...item, amount_cost: cost.negative_stock ? '' : String(cost.amount_cost) }
        })
      }))

      setCostWarnings(warnings)
    } catch (e) {
      console.error('Ошибка расчёта себестоимости', e)
    } finally {
      setCostCalcLoading(false)
    }
  }

  // Автоматический расчёт при изменении номенклатуры или количества
  const setItemFieldWithCalc = (key, field, val) => {
    setItemField(key, field, val)
    if (isOutgoing && (field === 'info_1_id' || field === 'quantity')) {
      // Небольшая задержка чтобы state обновился
      setTimeout(() => calcCost(false), 100)
    }
  }

  // Если план счетов или вид приехали после открытия формы создания —
  // подставляем счета по умолчанию, не трогая уже выбранное человеком
  useEffect(() => {
    if (!isEdit && balanceItems.length > 0 && type) {
      setForm(f => {
        const defaults = emptyDoc(type, balanceItems)
        return {
          ...f,
          type:          f.type          || defaults.type,
          bi_id:         f.bi_id         || defaults.bi_id,
          revenue_bi_id: f.revenue_bi_id ?? defaults.revenue_bi_id,
          cogs_bi_id:    f.cogs_bi_id    ?? defaults.cogs_bi_id,
        }
      })
    }
  }, [balanceItems.length, type?.id])

  // Счёт шапки
  const headBi = balanceItems.find(b => b.id == form.bi_id)

  // Загружаем аналитику для счёта шапки
  useEffect(() => {
    if (!headBi) return
    ;[headBi.info_1_type, headBi.info_2_type, headBi.info_3_type].filter(Boolean).forEach(t => {
      if (!infoCache[t]) loadInfo(t)
    })
  }, [form.bi_id])

  // Загружаем аналитику для счетов строк — и своих, и корреспондирующих:
  // строка может увести корреспонденцию на счёт с другой аналитикой
  useEffect(() => {
    form.items.forEach(item => {
      [item.bi_id, item.head_bi_id].filter(Boolean).forEach(id => {
        const bi = balanceItems.find(b => b.id == id)
        if (!bi) return
        ;[bi.info_1_type, bi.info_2_type, bi.info_3_type].filter(Boolean).forEach(t => {
          if (!infoCache[t]) loadInfo(t)
        })
      })
    })
  }, [form.items.map(i => `${i.bi_id}:${i.head_bi_id}`).join(',')])

  // Загружаем revenue аналитику для outgoing
  useEffect(() => {
    if (isOutgoing && !infoCache['revenue']) loadInfo('revenue')
  }, [isOutgoing])

  const setField = (field, val) => setForm(f => ({ ...f, [field]: val }))

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, emptyItem(type)] }))

  const removeItem = (key) => setForm(f => ({ ...f, items: f.items.filter(i => i._key !== key) }))

  const setItemField = (key, field, val) => setForm(f => ({
    ...f,
    items: f.items.map(i => {
      if (i._key !== key) return i
      const updated = { ...i, [field]: val }
      // Авторасчёт суммы при изменении qty или price
      if (field === 'quantity' || field === 'price') {
        const q = parseFloat(field === 'quantity' ? val : i.quantity) || 0
        const p = parseFloat(field === 'price'    ? val : i.price)    || 0
        updated.amount = q && p ? (q * p).toFixed(2) : i.amount
      }
      // Сброс аналитики при смене счёта строки
      if (field === 'bi_id') {
        updated.info_1_id = null
        updated.info_2_id = null
        updated.info_3_id = null
      }
      return updated
    })
  }))

  const buildPayload = () => ({
    ...form,
    bi_id: form.bi_id || undefined,
    items: form.items.map(({ _key, _expanded, ...i }) => ({
      ...i,
      quantity:    parseFloat(i.quantity)    || 0,
      price:       parseFloat(i.price)       || 0,
      amount:      parseFloat(i.amount)      || 0,
      amount_vat:  i.amount_vat  ? parseFloat(i.amount_vat)  : null,
      amount_cost: i.amount_cost ? parseFloat(i.amount_cost) : null,
    })),
  })

  /**
   * Одно действие на все кнопки: сохранить, при надобности провести, при
   * надобности закрыть. Сначала всегда сохранение — проведение читает строки
   * из базы, и себестоимость с прочими полями должны попасть туда раньше.
   */
  const perform = async ({ post = false, close = false } = {}) => {
    if (!form.bi_id) return setError('Укажите счёт в шапке документа')
    if (form.items.length === 0) return setError('Добавьте хотя бы одну строку')
    setSaving(true)
    setError('')
    try {
      const payload = buildPayload()
      const r = isEdit
        ? await updateDocument(doc.id, payload)
        : await createDocument(payload)
      let saved = r.data.data

      if (post) {
        const p = await postDocument(saved.id)
        saved = p.data.data
      }

      if (close) {
        onSave()
        return
      }
      // Остаёмся: новый документ становится редактируемым, проведённый —
      // проведённым, а родитель перечитывает списки за кадром
      setSavedDoc(saved)
      onChanged?.()
    } catch (err) {
      const errs = err.response?.data?.errors
      setError(errs ? Object.values(errs).flat().join(', ') : err.response?.data?.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = (e) => { e.preventDefault(); perform({ close: true }) }

  /** Отмена проведения — не закрывает: обычно её делают, чтобы тут же править */
  const unpost = async () => {
    setSaving(true)
    setError('')
    try {
      await cancelDocument(doc.id)
      const r = await getDocument(doc.id)
      setSavedDoc(r.data.data)
      onChanged?.()
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка отмены проведения')
    } finally {
      setSaving(false)
    }
  }

  const ic  = 'w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
  const lbl = 'block text-xs font-medium text-gray-500 mb-1'

  // Счета не ограничиваем списком кодов, как было раньше: вид документа
  // подставляет свой счёт по умолчанию, а выбрать можно любой — иначе каждый
  // новый вид требовал бы правки этого файла
  const allBiOptions = balanceItems

  const sideLabel = (side) => (side === 'debit' ? 'Дт' : 'Кт')

  /**
   * Корреспондирующая сторона в строке.
   *
   * Вид документа перечисляет, что выносится в строку колонкой: в авансовом
   * отчёте это статья ДДС — касса одна на документ, а статья у каждой траты
   * своя. Остальное правится в раскрывающейся панели строки.
   */
  const headBiForForm = balanceItems.find(b => b.id == form.bi_id)
  const lineHeadFields = type?.line_head_fields || []

  const headFieldLabel = (field) => {
    if (field === 'bi') return 'Счёт корр.'
    const infoType = headBiForForm?.[`info_${field.slice(-1)}_type`]
    return INFO_LABELS[infoType] || 'Аналитика'
  }

  /** Строка задала это поле сама, а не взяла из шапки */
  const headOverridden = (item, field) =>
    !!item[field === 'bi' ? 'head_bi_id' : `head_${field}_id`]

  const hasHeadOverride = (item) =>
    ['bi', 'info_1', 'info_2', 'info_3'].some(f => headOverridden(item, f))

  // Поля корреспондирующей стороны, которые есть смысл показывать: счёт всегда,
  // аналитика — только те слоты, что заданы у счёта шапки
  const headFieldsAvailable = ['bi', 'info_1', 'info_2', 'info_3'].filter(f =>
    f === 'bi' || headBiForForm?.[`info_${f.slice(-1)}_type`]
  )
  const headFieldsInPanel = headFieldsAvailable.filter(f => !lineHeadFields.includes(f))

  // Колонки строк задаёт вид документа: у начисления ЗП количества и цены нет,
  // у накладной есть. Сумма есть всегда — без неё документ бессмыслен.
  // Числа сидят в фиксированной ширине — им больше не нужно, — а всё
  // освободившееся место делят аналитики: их названиям тесно в первую очередь
  const itemGrid = [
    '1.5fr',
    ...lineHeadFields.map(() => '1.2fr'),   // корреспондирующая сторона по строкам
    isOutgoing ? '100px' : null,            // себестоимость
    showQty    ? '80px' : null,
    showPrice  ? '90px' : null,
    '110px',                                // сумма
    showVat    ? '90px' : null,
    '28px', '28px',
  ].filter(Boolean).join(' ')

  // Заголовок первой колонки — по аналитике счёта строк из вида документа:
  // «Номенклатура» у накладной, «Сотрудник» у ЗП, «Статья расхода» у авансового
  const typeItemBi = balanceItems.find(b => b.id == type?.item_bi_id)
  const firstColumnLabel = INFO_LABELS[typeItemBi?.info_1_type] || 'Аналитика'

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl my-4">

        {/* Заголовок */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-baseline gap-4 flex-wrap">
            <h2 className="text-lg font-semibold text-gray-800">
              {isEdit ? 'Редактировать' : 'Новый'}
              {' '}
              <span className="lowercase">{type?.name || 'документ'}</span>
              {isPosted && <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Проведён</span>}
            </h2>
            {/* Движения есть только у сохранённого документа — их порождает
                проведение. В операцию, созданную документом, не зайти, поэтому
                смотрят их отсюда */}
            {isEdit && (
              <div className="flex items-center gap-3 text-sm">
                <button type="button" onClick={() => setTab('fields')}
                  className={tab === 'fields'
                    ? 'text-blue-900 font-medium border-b-2 border-blue-900 pb-0.5'
                    : 'text-gray-400 hover:text-gray-600 pb-0.5'}>
                  Реквизиты
                </button>
                <button type="button" onClick={() => setTab('changes')}
                  className={tab === 'changes'
                    ? 'text-blue-900 font-medium border-b-2 border-blue-900 pb-0.5'
                    : 'text-gray-400 hover:text-gray-600 pb-0.5'}>
                  Движения
                </button>
              </div>
            )}
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        {tab === 'changes' ? (
          <div className="p-6 space-y-4">
            <OperationChanges documentId={doc.id} />
            <div className="flex justify-end pt-2">
              <button type="button" onClick={onCancel}
                className="px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
                Закрыть
              </button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleSubmit}>
          {/* ── Шапка ── */}
          <div className="px-6 pt-5 pb-4">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Шапка документа</div>
            {/* Строка 1: даты и номера — свои и из исходной программы рядом */}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div>
                <label className={lbl}>Дата и время</label>
                <input type="datetime-local" className={ic} value={form.date}
                  disabled={isPosted}
                  onChange={e => setField('date', e.target.value)} />
              </div>

              {/* Внутренний номер — показываем id если есть, иначе пусто */}
              <div>
                <label className={lbl}>Номер {isEdit && <span className="text-gray-300 font-normal">#{doc.id}</span>}</label>
                <input type="text" className={ic} value={form.number} placeholder="необязательно"
                  disabled={isPosted}
                  onChange={e => setField('number', e.target.value)} />
              </div>

              <div>
                <label className={lbl}>Внешний номер <span className="text-gray-300 font-normal">(из источника)</span></label>
                <input type="text" className={ic} value={form.external_number} placeholder="необязательно"
                  disabled={isPosted}
                  onChange={e => setField('external_number', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Внешняя дата</label>
                <input type="date" className={ic} value={form.external_date}
                  disabled={isPosted}
                  onChange={e => setField('external_date', e.target.value)} />
              </div>
            </div>

            {/* Строка 2: счёт шапки вместе со своей аналитикой — это одна
                сторона проводки, и читаться она должна одной строкой */}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4 mt-3">
              <div>
                <label className={lbl}>
                  Счёт шапки ({sideLabel(headSide)})
                  <span className="text-gray-300 font-normal"> — строки уйдут в {sideLabel(headSide === 'debit' ? 'credit' : 'debit')}</span>
                </label>
                <BiSelect items={allBiOptions} value={form.bi_id}
                  disabled={isPosted}
                  onChange={v => { setField('bi_id', v); setField('info_1_id', null); setField('info_2_id', null); setField('info_3_id', null) }}
                  placeholder="Выбрать счёт..." />
              </div>
              {headBi?.info_1_type && (
                  <div>
                    <label className={lbl}>{INFO_LABELS[headBi.info_1_type] || headBi.info_1_type}</label>
                    <InfoSelect items={infoCache[headBi.info_1_type] || []} value={form.info_1_id}
                      disabled={isPosted}
                      onChange={v => setField('info_1_id', v)}
                      placeholder={`Выбрать ${INFO_LABELS[headBi.info_1_type] || ''}...`} />
                  </div>
                )}
                {headBi?.info_2_type && (
                  <div>
                    <label className={lbl}>{INFO_LABELS[headBi.info_2_type] || headBi.info_2_type}</label>
                    <InfoSelect items={infoCache[headBi.info_2_type] || []} value={form.info_2_id}
                      disabled={isPosted}
                      onChange={v => setField('info_2_id', v)}
                      placeholder={`Выбрать...`} />
                  </div>
                )}
                {headBi?.info_3_type && (
                  <div>
                    <label className={lbl}>{INFO_LABELS[headBi.info_3_type] || headBi.info_3_type}</label>
                    <InfoSelect items={infoCache[headBi.info_3_type] || []} value={form.info_3_id}
                      disabled={isPosted}
                      onChange={v => setField('info_3_id', v)}
                      placeholder={`Выбрать...`} />
                  </div>
                )}
            </div>

            {/* Поля outgoing_invoice */}
            {isOutgoing && (
              <div className="grid grid-cols-3 gap-4 mt-3 pt-3 border-t border-gray-100">
                <div>
                  <label className={lbl}>Статья дохода</label>
                  <InfoSelect items={infoCache['revenue'] || []} value={form.revenue_item_id}
                    disabled={isPosted}
                    onChange={v => setField('revenue_item_id', v)}
                    placeholder="Выбрать статью..." />
                </div>
                <div>
                  <label className={lbl}>Счёт доходов (Кт)</label>
                  <BiSelect items={allBiOptions} value={form.revenue_bi_id}
                    disabled={isPosted}
                    onChange={v => setField('revenue_bi_id', v)}
                    placeholder="П587 Доходы" />
                </div>
                <div>
                  <label className={lbl}>Счёт себестоимости (Дт)</label>
                  <BiSelect items={allBiOptions} value={form.cogs_bi_id}
                    disabled={isPosted}
                    onChange={v => setField('cogs_bi_id', v)}
                    placeholder="П588 Себестоимость" />
                </div>
              </div>
            )}

          </div>

          {/* ── Табличная часть ── */}
          <div className="px-6 pb-5">
            <div className="flex items-center justify-end gap-2 mb-2">
              {/* Кнопка расчёта себестоимости — только для расходной */}
              {isOutgoing && !isPosted && form.items.length > 0 && (
                <button type="button" onClick={() => calcCost(true)} disabled={costCalcLoading}
                  className="text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-1">
                  {costCalcLoading ? '⏳' : '⚡'} Рассчитать себестоимость
                </button>
              )}
              {!isPosted && (
                <button type="button" onClick={addItem}
                  className="text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 px-3 py-1.5 rounded-lg font-medium transition-colors">
                  + Добавить строку
                </button>
              )}
            </div>

            {/* Предупреждения об отрицательных остатках */}
            {costWarnings.length > 0 && (
              <div className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                <span className="font-medium">⚠ Нулевой или отрицательный остаток:</span>{' '}
                {costWarnings.map(w => w.name).join(', ')} — себестоимость установлена в 0
              </div>
            )}

            {form.items.length === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-xl">
                Нажмите «+ Добавить строку»
              </div>
            ) : (
              <>
                {/* Заголовок колонок */}
                <div className="grid gap-2 mb-1 px-2 text-xs text-gray-400"
                  style={{ gridTemplateColumns: itemGrid }}>
                  <div>{firstColumnLabel}</div>
                  {lineHeadFields.map(f => <div key={f}>{headFieldLabel(f)}</div>)}
                  {isOutgoing && <div className="text-right">Себест.</div>}
                  {showQty   && <div className="text-right">Кол-во</div>}
                  {showPrice && <div className="text-right">Цена</div>}
                  <div className="text-right">Сумма</div>
                  {showVat   && <div className="text-right">НДС</div>}
                  <div /><div />
                </div>

                <div className="space-y-1">
                  {form.items.map((item, idx) => {
                    const itemBi   = balanceItems.find(b => b.id == item.bi_id)
                    // Аналитика корреспондирующей стороны берётся у того счёта,
                    // который в этой строке и стоит: строка могла его переопределить
                    const lineHeadBi = balanceItems.find(b => b.id == (item.head_bi_id || form.bi_id))
                    const headInfoItems = (f) => infoCache[lineHeadBi?.[`info_${f.slice(-1)}_type`]] || []
                    const expanded = item._expanded || false
                    const toggleExp = () => setForm(f => ({
                      ...f,
                      items: f.items.map(i => i._key === item._key ? { ...i, _expanded: !i._expanded } : i)
                    }))

                    return (
                      <div key={item._key} className={`rounded-lg border transition-colors ${expanded ? 'border-blue-200 bg-blue-50/30' : 'border-gray-200 bg-gray-50/50'}`}>

                        {/* ── Основная строка ── */}
                        <div className="grid gap-2 items-center px-2 py-1.5"
                          style={{ gridTemplateColumns: itemGrid }}>

                          {/* Аналитика строки — номенклатура, сотрудник, статья: что у счёта */}
                          <div className="min-w-0">
                            {itemBi?.info_1_type ? (
                              <InfoSelect
                                items={infoCache[itemBi.info_1_type] || []}
                                value={item.info_1_id}
                                disabled={isPosted}
                                onChange={v => setItemFieldWithCalc(item._key, 'info_1_id', v)}
                                placeholder={`${INFO_LABELS[itemBi.info_1_type] || 'Значение'}...`} />
                            ) : (
                              <span className="text-xs text-gray-400 px-2">
                                {itemBi ? `${itemBi.code} ${itemBi.name}` : 'Выберите счёт →'}
                              </span>
                            )}
                          </div>

                          {/* Корреспондирующая сторона по строкам: пусто — как
                              в шапке. Своё значение обводим янтарным: в списке
                              одинаковых строк должно быть видно, какая уходит
                              не туда, куда все остальные */}
                          {lineHeadFields.map(f => (
                            // Рамке нужен зазор вокруг контрола (p-1/-m-1):
                            // селект внутри непрозрачный и вплотную — янтарную
                            // подложку было просто не видно
                            <div key={f}
                              className={`min-w-0 rounded-lg ${
                                headOverridden(item, f) ? 'ring-1 ring-amber-300 bg-amber-50/60 p-1 -m-1' : ''
                              }`}
                              title={headOverridden(item, f) ? 'Переопределено в строке' : 'Берётся из шапки'}>
                              {f === 'bi' ? (
                                <BiSelect items={allBiOptions} value={item.head_bi_id}
                                  disabled={isPosted}
                                  onChange={v => setItemField(item._key, 'head_bi_id', v)}
                                  placeholder="как в шапке" />
                              ) : (
                                <InfoSelect
                                  items={headInfoItems(f)}
                                  value={item[`head_${f}_id`]}
                                  disabled={isPosted}
                                  onChange={v => setItemField(item._key, `head_${f}_id`, v)}
                                  placeholder="как в шапке" />
                              )}
                            </div>
                          ))}

                          {isOutgoing && (
                            <NumInput value={item.amount_cost} disabled={isPosted}
                              placeholder="—" step="0.01" className={ic + ' text-right'}
                              onChange={v => setItemField(item._key, 'amount_cost', v)} />
                          )}

                          {showQty && (
                            <NumInput value={item.quantity} disabled={isPosted}
                              placeholder="0" step="0.001" className={ic + ' text-right'}
                              onChange={v => setItemFieldWithCalc(item._key, 'quantity', v)} />
                          )}

                          {showPrice && (
                            <NumInput value={item.price} disabled={isPosted}
                              placeholder="0.00" step="0.0001" className={ic + ' text-right'}
                              onChange={v => setItemField(item._key, 'price', v)} />
                          )}

                          <NumInput value={item.amount} disabled={isPosted}
                            placeholder="0.00" step="0.01" className={ic + ' text-right font-medium'}
                            onChange={v => setItemField(item._key, 'amount', v)} />

                          {showVat && (
                            <NumInput value={item.amount_vat} disabled={isPosted}
                              placeholder="—" step="0.01" className={ic + ' text-right'}
                              onChange={v => setItemField(item._key, 'amount_vat', v)} />
                          )}

                          {/* Раскрыть. Точка сбоку — в строке есть своя
                              корреспонденция, спрятанная под кнопкой */}
                          <button type="button" onClick={toggleExp}
                            title={hasHeadOverride(item)
                              ? 'В строке своя корреспонденция'
                              : 'Счёт, аналитика, примечание'}
                            className={`relative w-6 h-6 flex items-center justify-center rounded text-xs font-bold transition-colors ${expanded ? 'bg-blue-100 text-blue-600' : 'text-gray-300 hover:text-gray-500 hover:bg-gray-100'}`}>
                            ···
                            {hasHeadOverride(item) && !expanded && (
                              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                            )}
                          </button>

                          {/* Удалить */}
                          {!isPosted ? (
                            <button type="button" onClick={() => removeItem(item._key)}
                              className="w-6 h-6 flex items-center justify-center rounded text-gray-300 hover:text-red-500 hover:bg-red-50 text-sm transition-colors">
                              ✕
                            </button>
                          ) : <div />}
                        </div>

                        {/* ── Раскрытая панель ── */}
                        {expanded && (
                          <div className="px-3 pb-3 pt-2 border-t border-blue-100">
                            <div className="grid gap-3"
                              style={{ gridTemplateColumns: [itemBi?.info_2_type, itemBi?.info_3_type].filter(Boolean).length === 0 ? '1fr 1fr' : itemBi?.info_3_type ? '1fr 1fr 1fr' : '1fr 1fr 1fr' }}>

                              {/* Счёт строки */}
                              <div>
                                <div className="text-xs text-gray-400 mb-1">
                                  Счёт строки ({sideLabel(headSide === 'debit' ? 'credit' : 'debit')})
                                </div>
                                <BiSelect
                                  items={allBiOptions}
                                  value={item.bi_id}
                                  disabled={isPosted}
                                  onChange={v => setItemField(item._key, 'bi_id', v)}
                                  placeholder="Выбрать счёт..." />
                              </div>

                              {itemBi?.info_2_type && (
                                <div>
                                  <div className="text-xs text-gray-400 mb-1">{INFO_LABELS[itemBi.info_2_type]}</div>
                                  <InfoSelect items={infoCache[itemBi.info_2_type] || []} value={item.info_2_id}
                                    disabled={isPosted}
                                    onChange={v => setItemField(item._key, 'info_2_id', v)}
                                    placeholder="Выбрать..." />
                                </div>
                              )}

                              {itemBi?.info_3_type && (
                                <div>
                                  <div className="text-xs text-gray-400 mb-1">{INFO_LABELS[itemBi.info_3_type]}</div>
                                  <InfoSelect items={infoCache[itemBi.info_3_type] || []} value={item.info_3_id}
                                    disabled={isPosted}
                                    onChange={v => setItemField(item._key, 'info_3_id', v)}
                                    placeholder="Выбрать..." />
                                </div>
                              )}

                              {/* Корреспондирующая сторона: то, что не вынесено
                                  колонкой. Пустое поле значит «как в шапке» —
                                  поэтому подставленное значение здесь не
                                  показывается, чтобы его не приняли за своё */}
                              {headFieldsInPanel.length > 0 && (
                                <div style={{ gridColumn: '1 / -1' }}
                                  className="border-t border-blue-100 pt-2 mt-1">
                                  <div className="text-xs text-gray-400 mb-1.5">
                                    Корреспондирующая сторона ({sideLabel(headSide)})
                                    <span className="text-gray-300"> — пусто значит «как в шапке»</span>
                                  </div>
                                  <div className="grid gap-3" style={{
                                    gridTemplateColumns: `repeat(${Math.min(headFieldsInPanel.length, 3)}, 1fr)`,
                                  }}>
                                    {headFieldsInPanel.map(f => (
                                      <div key={f} className={headOverridden(item, f)
                                        ? 'rounded-lg ring-1 ring-amber-300 bg-amber-50/40 p-1.5 -m-1.5' : ''}>
                                        <div className="text-xs text-gray-400 mb-1">
                                          {headFieldLabel(f)}
                                          {headOverridden(item, f) && (
                                            <span className="ml-1 text-amber-600">· своё</span>
                                          )}
                                        </div>
                                        {f === 'bi' ? (
                                          <BiSelect items={allBiOptions} value={item.head_bi_id}
                                            disabled={isPosted}
                                            onChange={v => setItemField(item._key, 'head_bi_id', v)}
                                            placeholder="как в шапке" />
                                        ) : (
                                          <InfoSelect
                                            items={headInfoItems(f)}
                                            value={item[`head_${f}_id`]}
                                            disabled={isPosted}
                                            onChange={v => setItemField(item._key, `head_${f}_id`, v)}
                                            placeholder="как в шапке" />
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Примечание — всегда последнее, занимает всю ширину */}
                              <div style={{ gridColumn: '1 / -1' }}>
                                <div className="text-xs text-gray-400 mb-1">Примечание к строке</div>
                                <input type="text" className={ic} value={item.note}
                                  disabled={isPosted} placeholder="необязательно"
                                  onChange={e => setItemField(item._key, 'note', e.target.value)} />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {/* Итого */}
            {form.items.length > 0 && (
              <div className="flex justify-end mt-3 pt-3 border-t border-gray-100">
                <div className="text-sm text-gray-500 mr-4">Итого:</div>
                <div className="text-sm font-semibold text-gray-800">
                  {fmt(form.items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0))} ₽
                </div>
              </div>
            )}

            {/* Комментарий — в самом низу: он про документ целиком и пишется
                последним, когда цифры уже сошлись */}
            <div className="mt-3">
              <label className={lbl}>Комментарий</label>
              <input type="text" className={ic} value={form.note} placeholder="необязательно"
                disabled={isPosted}
                onChange={e => setField('note', e.target.value)} />
            </div>
          </div>

          {/* ── Футер ── */}
          {error && <div className="mx-6 mb-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
          <div className="flex gap-2 items-center px-6 py-4 border-t border-gray-100 flex-wrap">

            <button type="button" onClick={onCancel}
              className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">
              {isPosted ? 'Закрыть' : 'Отмена'}
            </button>

            {/* Черновик: пары «остаться» и «закрыть». Остаться — когда вводят
                несколько документов подряд или хотят увидеть движения */}
            {!isPosted && (
              <div className="flex gap-2 ml-auto flex-wrap">
                <button type="button" onClick={() => perform({})} disabled={saving}
                  className="px-4 py-2 text-sm text-blue-900 border border-blue-200 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50">
                  Сохранить
                </button>
                <button type="button" onClick={() => perform({ post: true })} disabled={saving}
                  className="px-4 py-2 text-sm text-green-700 border border-green-300 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50">
                  ✓ Провести
                </button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm text-white bg-blue-900 hover:bg-blue-800 rounded-lg transition-colors disabled:opacity-50">
                  {saving ? 'Сохранение...' : 'Сохранить и закрыть'}
                </button>
                <button type="button" onClick={() => perform({ post: true, close: true })} disabled={saving}
                  className="px-4 py-2 text-sm text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors font-medium disabled:opacity-50">
                  {saving ? 'Сохранение...' : '✓ Провести и закрыть'}
                </button>
              </div>
            )}

            {/* Проведённый: снять проведение — не закрывает, обычно её делают,
                чтобы тут же поправить и провести заново */}
            {isEdit && isPosted && (
              <button type="button" onClick={unpost} disabled={saving}
                className="ml-auto px-4 py-2 text-sm text-orange-700 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-lg transition-colors font-medium disabled:opacity-50">
                {saving ? '...' : '↩ Отменить проведение'}
              </button>
            )}
          </div>
        </form>
        )}
      </div>
    </div>
  )
}

// ─── Основная страница ────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const navigate  = useNavigate()
  const location  = useLocation()
  // Вкладки — виды документов из справочника. Пока он не приехал, вкладки нет:
  // выбирать не из чего, и запрашивать документы «вида null» незачем
  const [types, setTypes]           = useState(null)
  const [tab, setTab]               = useState('')
  const [docs, setDocs]             = useState([])
  const [loading, setLoading]       = useState(false)
  const [balanceItems, setBalanceItems] = useState([])
  const [infoCache, setInfoCache]   = useState({})
  const [showForm, setShowForm]     = useState(false)
  const [editDoc, setEditDoc]       = useState(null)
  const [actionLoading, setActionLoading] = useState(null)
  const [actionError, setActionError]     = useState('')

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getBalanceItems().then(r => setBalanceItems(r.data.data))
    getDocumentTypes({ active: 1 }).then(r => {
      const list = r.data.data || []
      setTypes(list)
      setTab(t => t || list[0]?.code || '')
    })
  }, [])

  useEffect(() => { if (tab) loadDocs() }, [tab])

  const activeType = types?.find(t => t.code === tab) || null

  // Открываем конкретный документ если в URL есть ?open=ID
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const openId = params.get('open')
    if (!openId) return

    getDocument(openId).then(r => {
      const doc = r.data.data
      // Переключаемся на нужную вкладку
      setTab(doc.type)
      setEditDoc(doc)
      setShowForm(true)
      // Убираем параметр из URL без перезагрузки
      navigate('/documents', { replace: true })
    }).catch(() => {})
  }, [location.search])

  const loadDocs = () => {
    setLoading(true)
    getDocuments({ type: tab, per_page: 100 })
      .then(r => setDocs(r.data.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  const loadInfo = (type) => {
    getInfo({ type }).then(r => setInfoCache(c => ({ ...c, [type]: r.data.data })))
  }

  const openCreate = () => {
    setEditDoc(null)
    setShowForm(true)
  }

  const openEdit = async (doc) => {
    const r = await getDocument(doc.id)
    setEditDoc(r.data.data)
    setShowForm(true)
  }

  const handleSaved = () => {
    setShowForm(false)
    loadDocs()
  }

  // Проведение — можно вызвать и из списка и из формы
  const handlePost = async (doc) => {
    setActionLoading(doc.id)
    setActionError('')
    try {
      await postDocument(doc.id)
      loadDocs()
      // Закрываем форму после проведения
      if (showForm) {
        setShowForm(false)
        setEditDoc(null)
      }
    } catch (err) {
      setActionError(err.response?.data?.message || 'Ошибка проведения')
      setTimeout(() => setActionError(''), 4000)
    } finally {
      setActionLoading(null)
    }
  }

  const handleCancel = async (doc) => {
    setActionLoading(doc.id)
    setActionError('')
    try {
      await cancelDocument(doc.id)
      loadDocs()
      // Если форма открыта — обновляем её
      if (showForm) {
        const r = await getDocument(doc.id)
        setEditDoc(r.data.data)
      }
    } catch (err) {
      setActionError(err.response?.data?.message || 'Ошибка отмены проведения')
      setTimeout(() => setActionError(''), 4000)
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async (doc) => {
    if (!window.confirm(`Удалить документ?`)) return
    setActionLoading(doc.id)
    setActionError('')
    try {
      await deleteDocument(doc.id)
      setShowForm(false)
      loadDocs()
    } catch (err) {
      setActionError(err.response?.data?.message || 'Ошибка удаления')
      setTimeout(() => setActionError(''), 4000)
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <Layout>
      {/* Заголовок */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Документы</h1>
        <button onClick={openCreate} disabled={!activeType}
          className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors disabled:opacity-50">
          + Создать {activeType ? activeType.name.toLowerCase() : ''}
        </button>
      </div>

      {/* Вкладки — виды документов из справочника */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 flex-wrap">
        {(types || []).map(t => (
          <button key={t.code} onClick={() => setTab(t.code)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.code
                ? 'border-blue-900 text-blue-900'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}>
            {t.name}
          </button>
        ))}
        {types !== null && types.length === 0 && (
          <div className="px-1 py-2.5 text-sm text-gray-400">
            Ни одного вида документа не заведено — они настраиваются в разделе «Настройки → Виды документов»
          </div>
        )}
      </div>

      {/* Тост ошибки */}
      {actionError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} className="ml-4 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* Список документов */}
      {loading || types === null ? (
        <SkeletonRows rows={5} height="h-12" />
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-5xl mb-4">📄</div>
          <div className="text-lg font-medium text-gray-500 mb-1">Нет документов</div>
          <div className="text-sm">Нажмите «+ Создать» чтобы добавить первый</div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-12">#</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Дата</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Номер</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {/* Кто в шапке — контрагент, сотрудник или статья: зависит от счёта вида */}
                  {INFO_LABELS[balanceItems.find(b => b.id == activeType?.head_bi_id)?.info_1_type] || 'Аналитика'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Статус</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wide">Сумма</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Примечание</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {docs.map(doc => {
                const st     = STATUS_LABELS[doc.status] || STATUS_LABELS.draft
                const busy   = actionLoading === doc.id
                return (
                  <tr key={doc.id} className="group hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{doc.id}</td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      <div>{doc.date ? new Date(doc.date).toLocaleDateString('ru-RU') : '—'}</div>
                      <div className="text-xs text-gray-400">{doc.date ? new Date(doc.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-500 text-xs">
                      {doc.number || doc.external_number || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div>{doc.info_1_name || <span className="text-gray-300">не указан</span>}</div>
                      {doc.bi_code && (
                        <div className="text-xs text-gray-400 font-mono">{doc.bi_code}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${st.cls}`}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-800 whitespace-nowrap">
                      {doc.amount > 0 ? `${fmt(doc.amount)} ₽` : <span className="text-gray-300 font-normal">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">
                      {doc.content || doc.note || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">

                        {/* Редактировать — для draft */}
                        {doc.status === 'draft' && (
                          <button onClick={() => openEdit(doc)}
                            className="text-gray-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 text-sm" title="Редактировать">
                            ✎
                          </button>
                        )}
                        {/* Просмотр — для posted и cancelled */}
                        {(doc.status === 'posted' || doc.status === 'cancelled') && (
                          <button onClick={() => openEdit(doc)}
                            className="text-gray-400 hover:text-gray-600 p-1.5 rounded hover:bg-gray-100 text-sm" title="Просмотр">
                            👁
                          </button>
                        )}

                        {/* Провести — для draft */}
                        {doc.status === 'draft' && (
                          <button onClick={() => handlePost(doc)} disabled={busy}
                            className="text-gray-400 hover:text-green-600 p-1.5 rounded hover:bg-green-50 text-sm disabled:opacity-40"
                            title="Провести">
                            {busy ? '⏳' : '✓'}
                          </button>
                        )}

                        {/* Отменить проведение — только posted → draft */}
                        {doc.status === 'posted' && (
                          <button onClick={() => handleCancel(doc)} disabled={busy}
                            className="text-gray-400 hover:text-orange-500 p-1.5 rounded hover:bg-orange-50 text-sm disabled:opacity-40" title="Отменить проведение">
                            {busy ? '⏳' : '↩'}
                          </button>
                        )}

                        {/* Удалить — для draft и cancelled */}
                        {(doc.status === 'draft' || doc.status === 'cancelled') && (
                          <button onClick={() => handleDelete(doc)} disabled={busy}
                            className="text-gray-400 hover:text-red-500 p-1.5 rounded hover:bg-red-50 text-sm disabled:opacity-40" title="Удалить">
                            ✕
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Форма создания/редактирования */}
      {showForm && (
        <DocumentForm
          docType={tab}
          type={editDoc ? types?.find(t => t.code === editDoc.type) || activeType : activeType}
          doc={editDoc}
          balanceItems={balanceItems}
          infoCache={infoCache}
          loadInfo={loadInfo}
          onSave={handleSaved}
          onCancel={() => { setShowForm(false); loadDocs() }}
          onChanged={loadDocs}
        />
      )}
    </Layout>
  )
}
