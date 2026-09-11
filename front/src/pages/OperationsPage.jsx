import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { getOperations, deleteOperation, getBalanceItems, createOperation, setOperationPosting } from '../api/operations'
import { getProjects } from '../api/projects'
import OperationForm from '../components/OperationForm'
import OperationTemplates from '../components/OperationTemplates'
import { createTemplate } from '../api/operationTemplates'
import Layout from '../components/Layout'
import PeriodPicker from '../components/PeriodPicker'
import usePersistedPeriod from '../hooks/usePersistedPeriod'
import usePersistedState from '../hooks/usePersistedState'
import BulkEditOperations from '../components/BulkEditOperations'
import { DocumentForm } from './DocumentsPage'
import { getDocument } from '../api/documents'
import { getInfo } from '../api/info'
import { BusyLabel, BusyOverlay, SkeletonRows } from '../components/Busy'
import AccountChip from '../components/AccountChip'
import LockIcon from '../components/LockIcon'
import { Highlight } from '../utils/infoSearch'

const INFO_TYPES = [
  { id: 'partner', name: 'Контрагенты' },
  { id: 'product', name: 'Товары/Услуги' },
  { id: 'cash', name: 'Кассы/Счета' },
  { id: 'employee', name: 'Сотрудники' },
  { id: 'revenue', name: 'Статьи доходов' },
  { id: 'expenses', name: 'Статьи расходов' },
  { id: 'department', name: 'Отделы' },
  { id: 'flow', name: 'Статьи ДДС' },
]

const SearchableSelect = ({ label, value, onChange, options, placeholder }) => {
  const [search, setSearch] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  // Фильтруем опции по вводу пользователя
  const filtered = options.filter(opt => 
    opt.name.toLowerCase().includes(search.toLowerCase()) || 
    (opt.code && opt.code.toLowerCase().includes(search.toLowerCase()))
  )

  const selectedOption = options.find(o => o.id === value)

  return (
    <div className="relative flex flex-col gap-1">
      <span className="text-xs text-gray-500 font-medium">{label}:</span>
      <div className="relative">
        <input
          type="text"
          className="w-full px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={selectedOption ? selectedOption.name : placeholder}
          value={search}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => setSearch(e.target.value)}
        />
        {isOpen && (
          <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
            {filtered.length > 0 ? filtered.map(opt => (
              <div
                key={opt.id}
                className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer flex justify-between"
                onClick={() => {
                  onChange(opt.id)
                  setSearch('')
                  setIsOpen(false)
                }}
              >
                <span>{opt.name}</span>
                {opt.code && <span className="text-gray-400 text-xs font-mono">{opt.code}</span>}
              </div>
            )) : <div className="px-3 py-2 text-sm text-gray-400">Ничего не найдено</div>}
          </div>
        )}
      </div>
      {isOpen && <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)}></div>}
    </div>
  )
}



// Единая сетка колонок для шапки и карточек операций (выравнивание между карточками).
// Содержание — предпоследняя колонка: под ним ещё и примечание с реквизитами
// контрагента, поэтому она расширена (130px/1fr → 207px/1.59fr) и теперь заметно
// шире колонок дебета и кредита.
const OP_GRID = 'grid grid-cols-[2rem_2.5rem_10rem_minmax(170px,1.3fr)_minmax(170px,1.3fr)_7.5rem_minmax(207px,1.59fr)_4rem] gap-x-3'

// Сколько операций приезжает за раз. Двести — столько же, сколько страница
// показывала раньше: привычный объём списка, но теперь это честная первая
// порция, а не молчаливый обрыв периода
const PER_PAGE = 200

/**
 * Кусок текста вокруг найденного.
 *
 * Назначение платежа из выписки обрезается двумя строками, а совпадение часто
 * стоит в середине — и подсветка оказывается за краем: операция выглядит
 * найденной неизвестно за что. Показываем текст начиная чуть раньше
 * совпадения; целиком он остаётся во всплывающей подсказке.
 */
const snippet = (text, q, lead = 40) => {
  if (!text || !q) return text

  const i = String(text).toLowerCase().indexOf(String(q).toLowerCase())

  return i > lead + 20 ? '…' + String(text).slice(i - lead) : text
}

/**
 * Поле поиска.
 *
 * Набранный текст держит в себе, наружу отдаёт только готовый запрос — по
 * Enter или по лупе. Иначе каждая буква меняла бы состояние страницы, а вместе
 * с ним перерисовывались бы все двести карточек списка: именно от этого набор
 * и подтормаживал, хотя по существу в этот момент ничего не происходит.
 */
function SearchBox({ applied, onSearch, className = '' }) {
  const [value, setValue] = useState(applied)

  // Запрос сбросили снаружи — крестиком на бейдже или из пустого списка
  useEffect(() => { setValue(applied) }, [applied])

  const dirty = value.trim() !== applied

  return (
    <div className={`relative ${className}`}>
      {/* Лупа внутри поля, а не отдельной кнопкой рядом: искать ей можно,
          но глазу она прежде всего говорит, что это поле — поиск.
          Синеет, пока набранное не совпадает с найденным: видно, что список
          показывает ещё прошлый запрос */}
      <button type="button" onClick={() => onSearch(value.trim())} title="Искать (Enter)"
        className={`absolute left-2.5 top-1/2 -translate-y-1/2 transition-colors ${
          dirty ? 'text-blue-600 hover:text-blue-800' : 'text-gray-400 hover:text-gray-600'
        }`}>
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
      </button>

      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter')  { e.preventDefault(); onSearch(value.trim()) }
          if (e.key === 'Escape') { setValue(''); onSearch('') }
        }}
        placeholder="Поиск по журналу — Enter"
        title="Ищет по содержанию, примечанию, контрагенту, счёту, сумме и номеру операции"
        className="w-full pl-9 pr-8 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {value && (
        <button type="button" onClick={() => { setValue(''); onSearch('') }} title="Очистить (Esc)"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600 text-sm">✕</button>
      )}
    </div>
  )
}

/**
 * Действующий поиск — жёлтым бейджем среди фильтров.
 *
 * Поиск сужает список наравне с периодом и счётом, поэтому и стоять должен
 * там же, где остальные отборы, а не подписью у поля ввода. Жёлтый тот же, что
 * у подсветки совпадений: понятно, откуда она взялась.
 */
function SearchBadge({ q, found, onClear }) {
  if (!q) return null

  return (
    <span className="inline-flex items-center gap-1.5 bg-amber-100 text-amber-900 border border-amber-200
                     rounded-full pl-2.5 pr-1 py-0.5 text-xs whitespace-nowrap">
      «{q}»: {found}
      <button type="button" onClick={onClear} title="Очистить поиск"
        className="text-amber-600 hover:text-amber-900 px-0.5">✕</button>
    </span>
  )
}

export default function OperationsPage() {
  const navigate = useNavigate()
  const [operations, setOperations] = useState([])
  const [balanceItems, setBalanceItems] = useState([])
  const [projects, setProjects] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editOperation, setEditOperation] = useState(null)
  const [draftOperation, setDraftOperation] = useState(null)   // черновик от ИИ
  const [tplKey, setTplKey] = useState(0)                      // перезагрузка списка шаблонов
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // Период запоминается между заходами и хранится отдельно от прочих фильтров
  const [period, setPeriod] = usePersistedPeriod('operations')
  const [filter, setFilter] = useState({ in_bi_id: '', out_bi_id: '', project_id: '', is_posted: '' })
  // Применённый запрос. Набранный текст живёт внутри SearchBox — см. там
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  // Итоги за период считает сервер — список приезжает страницами
  const [summary, setSummary] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [showBulkEdit, setShowBulkEdit] = useState(false)
  // Документ-источник открываем сразу для правки и поверх списка: уходить со
  // страницы посреди разбора операций незачем, а вернуться потом — значит
  // заново задать период
  const [docModal, setDocModal]         = useState(null)   // { doc }
  const [docInfoCache, setDocInfoCache] = useState({})
  const [docError, setDocError]         = useState('')
  // Примечание — отдельной строкой под карточкой. Кому мешает, тот выключит
  const [showNotes, setShowNotes] = usePersistedState('ops:show-notes', true)
  const tenant = JSON.parse(localStorage.getItem('tenant') || '{}')

    // --- НОВЫЕ СОСТОЯНИЯ ---
  const [infoType, setInfoType] = useState('')       // Тип (partner, product и т.д.)
  const [infoOptions, setInfoOptions] = useState([]) // Список элементов из БД
  const [selectedInfoId, setSelectedInfoId] = useState('') // Конкретный ID элемента

  useEffect(() => {
    api.get('/me').catch(() => navigate('/login'))
    getBalanceItems().then(res => setBalanceItems(res.data.data))
    getProjects().then(res => setProjects(res.data.data || []))
  }, [])
  // Загружаем элементы справочника при смене типа (например, выбрали "Контрагенты")
  useEffect(() => {
    if (infoType) {
      api.get('/info', { params: { type: infoType } })
        .then(res => setInfoOptions(res.data.data))
        .catch(err => console.error("Ошибка загрузки справочника:", err))
    } else {
      setInfoOptions([])
    }
    setSelectedInfoId('') // Сбрасываем фильтр по конкретному элементу
  }, [infoType])


  useEffect(() => {
    loadOperations(1)
  }, [filter, period, selectedInfoId, q])

  /**
   * Список операций страницами.
   *
   * Раньше страница просила 200 операций и молча показывала их как весь
   * период: за 201-й никто не приходил, а карточки «операций за период» и
   * «сумма за период» складывались из приехавшего — то есть врали ровно тогда,
   * когда правда нужнее всего. Теперь количество и суммы считает сервер по
   * всему отбору, а список догружается по кнопке.
   */
  const loadOperations = (nextPage = 1, span = 1) => {
    const first = nextPage === 1
    first ? setLoading(true) : setLoadingMore(true)
    // Выделение живёт в пределах показанного списка: после смены отбора
    // сохранять его не в чем
    if (first) setSelected(new Set())

    // span — сколько страниц перечитать одним запросом. Нужен при обновлении
    // после правки: иначе список схлопнулся бы к первой странице, и человек,
    // догрузивший шестьсот строк, потерял бы место, на котором работал
    const params = { page: nextPage, per_page: Math.min(PER_PAGE * span, 1000) }

    if (period.from)      params.date_from  = period.from
    if (period.to)        params.date_to    = period.to
    if (filter.in_bi_id)  params.in_bi_id   = filter.in_bi_id
    if (filter.out_bi_id) params.out_bi_id  = filter.out_bi_id
    if (filter.project_id) params.project_id = filter.project_id
    // Именно !== '': «0» — это осмысленный фильтр «только непроведённые»
    if (filter.is_posted !== '') params.is_posted = filter.is_posted
    if (selectedInfoId)   params.info_id    = selectedInfoId
    if (q)                params.q          = q

    getOperations(params)
      .then(res => {
        const rows = res.data.data || []
        setOperations(prev => first ? rows : [...prev, ...rows])
        setSummary(res.data.summary || null)
        setPage(first ? span : nextPage)
      })
      .finally(() => { setLoading(false); setLoadingMore(false) })
  }

  // Показать следующую порцию
  const loadMore = () => loadOperations(page + 1)

  // Перечитать ровно то, что уже показано — после правки, удаления, проведения
  const reload = () => loadOperations(1, page)

  // Проведение — не правка реквизитов, а включение операции в обороты,
  // поэтому отдельным запросом и без формы
  const togglePosting = async (op) => {
    try {
      await setOperationPosting(op.id, !op.is_posted)
      reload()
    } catch (err) {
      alert(err.response?.data?.message || 'Не удалось изменить проведение')
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Удалить операцию?')) return
    try {
      await deleteOperation(id)
      reload()
    } catch (err) {
      alert(err.response?.data?.message || 'Не удалось удалить операцию')
    }
  }

  // ── Документ-источник ─────────────────────────────────────────────────────

  const openDocument = async (tableId) => {
    setDocError('')
    try {
      const r = await getDocument(tableId)
      setDocModal({ doc: r.data.data })
    } catch {
      setDocError('Документ не найден — возможно, его удалили')
      setTimeout(() => setDocError(''), 4000)
    }
  }

  const loadDocInfo = (type) => {
    getInfo({ type }).then(r => setDocInfoCache(c => ({ ...c, [type]: r.data.data })))
  }

  const handleEdit = (op) => { setDraftOperation(null); setEditOperation(op); setShowForm(true) }
  const handleUseDraft = (payload) => { setEditOperation(null); setDraftOperation(payload); setShowForm(true) }
  const handleFormClose = () => { setShowForm(false); setEditOperation(null); setDraftOperation(null) }

  // Сохранить операцию как шаблон для повторения в следующем периоде
  const saveTemplate = async (payload, defaultName) => {
    const name = prompt('Название шаблона (короткая фраза для кнопки):', defaultName || '')
    if (!name || !name.trim()) return
    try {
      await createTemplate(name.trim(), payload)
      setTplKey(k => k + 1)
    } catch (err) {
      alert(err.response?.data?.message || 'Не удалось сохранить шаблон')
    }
  }

  const templateFromOp = (op) => saveTemplate({
    project_id: op.project_id, amount: op.amount,
    in_quantity: op.in_quantity, out_quantity: op.out_quantity,
    in_bi_id: op.in_bi_id, out_bi_id: op.out_bi_id,
    in_info_1_id: op.in_info_1_id, in_info_2_id: op.in_info_2_id, in_info_3_id: op.in_info_3_id,
    out_info_1_id: op.out_info_1_id, out_info_2_id: op.out_info_2_id, out_info_3_id: op.out_info_3_id,
    content: op.content, note: op.note,
  }, op.content || '')

  /**
   * Копия операции: те же реквизиты, новая запись.
   *
   * Дату не переносим — форма подставит текущую: копируют, чтобы записать
   * такую же операцию сейчас, а не задним числом. Открываем форму, а не
   * создаём молча: копируют обычно ради того, чтобы что-то в копии изменить.
   *
   * Счета местами меняются кнопкой в самой форме, если копия нужна обратная.
   */
  const copyOp = (op) => {
    handleUseDraft({
      project_id:    op.project_id,
      amount:        op.amount,
      in_quantity:   op.in_quantity,
      out_quantity:  op.out_quantity,
      in_bi_id:      op.in_bi_id,
      out_bi_id:     op.out_bi_id,
      in_info_1_id:  op.in_info_1_id,
      in_info_2_id:  op.in_info_2_id,
      in_info_3_id:  op.in_info_3_id,
      out_info_1_id: op.out_info_1_id,
      out_info_2_id: op.out_info_2_id,
      out_info_3_id: op.out_info_3_id,
      content:       op.content,
      note:          op.note,
      is_posted:     op.is_posted,
    })
  }

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(selected.size === operations.length ? new Set() : new Set(operations.map(op => op.id)))
  }

  const allChecked  = operations.length > 0 && selected.size === operations.length
  const someChecked = selected.size > 0 && selected.size < operations.length

  // Количество и сумма — за весь период, из ответа сервера. Пока он не
  // ответил (первая отрисовка), показываем то, что есть на руках
  const totalCount    = summary?.count ?? operations.length
  const totalAll      = summary?.amount ?? operations.reduce((sum, op) => sum + parseFloat(op.amount), 0)
  const totalSelected = operations.filter(op => selected.has(op.id)).reduce((sum, op) => sum + parseFloat(op.amount), 0)
  const hasMore       = operations.length < totalCount

  /**
   * Чем операция зацепилась за поиск.
   *
   * Текстовые совпадения подсвечиваются прямо в тексте. Сумма и номер — числа,
   * подсвечивать в них нечего, поэтому помечаем саму ячейку: иначе строка,
   * найденная по сумме, выглядит попавшей в список без причины.
   */
  const qAmount = useMemo(() => {
    // \s покрывает и неразрывный пробел — тот, которым список разделяет
    // разряды: сумму часто копируют прямо из него
    const n = Number(String(q).replace(/\s/g, '').replace(',', '.'))
    return q && !isNaN(n) ? n : null
  }, [q])

  const qId = useMemo(() => {
    const m = /^#?(\d+)$/.exec(q)
    return m ? Number(m[1]) : null
  }, [q])

  const hitCell = 'bg-amber-100 rounded px-1 -mx-1'

  // Обороты по счетам тоже считает сервер: сложенные по показанным строкам,
  // они противоречили бы карточке «сумма за период» над тем же списком
  const accountTotals = useMemo(() => (summary?.accounts || []).map(a => ({
    ...a,
    // Код счёта в начале названия уже стоит отдельной колонкой
    name: a.hidden ? a.name : (a.name || '').replace(/^[А-ЯA-Z]\d+\s/, ''),
  })), [summary])

  const formatAmount = (amount) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(amount)

  const formatDate = (date) =>
    new Date(date).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })

  /**
   * Дата и время «как на стене» — без перевода в UTC.
   *
   * Тот же формат, что шлёт форма операции: операция сравнивается с датой
   * запрета по локальной дате, и сдвиг на часовой пояс мог бы утащить копию
   * на сутки назад — обратно в закрытый период.
   */
  const localNow = () => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  const handleCopySelected = async () => {
    if (selected.size === 0) return
    if (!confirm(`Скопировать выбранные операции (${selected.size} шт.) на текущую дату?`)) return

    setLoading(true)
    try {
      // Фильтруем массив операций, оставляя только выделенные
      const opsToCopy = operations.filter(op => selected.has(op.id))
      // Одно время на всю пачку: копии одного действия должны лечь рядом,
      // а не разъехаться по секундам
      const copyDate = localNow()

      // Выполняем запросы последовательно (или через Promise.all)
      for (const op of opsToCopy) {
        const payload = {
          // Дату не переносим: копируют, чтобы записать такую же операцию
          // сейчас. Исходная дата часто лежит в закрытом периоде, и сервер
          // законно отказывал — а копия туда и не метила
          date: copyDate,
          project_id: op.project_id,
          amount: op.amount,
          in_quantity: op.in_quantity,
          out_quantity: op.out_quantity,
          in_bi_id: op.in_bi_id,
          in_info_1_id: op.in_info_1_id,
          in_info_2_id: op.in_info_2_id,
          in_info_3_id: op.in_info_3_id,
          out_bi_id: op.out_bi_id,
          out_info_1_id: op.out_info_1_id,
          out_info_2_id: op.out_info_2_id,
          out_info_3_id: op.out_info_3_id,
          content: op.content ?? '',
          note: op.note ? `${op.note} (Копия)` : 'Копия'
        }
        await createOperation(payload)
      }
      
      // Сбрасываем выделение и обновляем список
      setSelected(new Set())
      reload()
    } catch (err) {
      alert(err.response?.data?.message || 'Произошла ошибка при копировании')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }
  

  return (
    <Layout>
      {/* Карточки */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">
            {q ? 'Найдено операций' : 'Операций за период'}
          </p>
          <p className="text-3xl font-bold text-gray-800">{totalCount}</p>
          {hasMore && (
            <p className="text-[11px] text-gray-400 mt-1">показано {operations.length}</p>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">
            {q ? 'Сумма найденного' : 'Сумма за период'}
          </p>
          <p className="text-2xl font-bold text-blue-600">{formatAmount(totalAll)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">
            Выбрано {selected.size > 0 ? `(${selected.size})` : ''}
          </p>
          <p className={`text-2xl font-bold ${selected.size > 0 ? 'text-orange-500' : 'text-gray-300'}`}>
            {formatAmount(totalSelected)}
          </p>
        </div>
      </div>

      {/* Шаблоны регулярных операций */}
      <OperationTemplates onUse={handleUseDraft} refreshKey={tplKey} />

      {/* Диалог с ИИ переехал в свой раздел — «AI-помощник» в меню:
          он длинный, и списку операций под ним было тесно */}

      {/* Таблица операций */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm mb-4">
        
        {/* Замени блок заголовка таблицы */}
<div className="flex justify-between items-center gap-4 px-6 py-4 border-b border-gray-100">
  <div className="flex items-center gap-4 flex-1 min-w-0">
    <h2 className="font-semibold text-gray-800 whitespace-nowrap">Операции</h2>

    {/* Поиск — сразу за заголовком, до фильтров: с него чаще всего и
        начинают, когда ищут конкретную операцию, а не разбирают период.
        Ищет сервер и по всему периоду, а не по показанным строкам */}
    <SearchBox applied={q} onSearch={setQ} className="flex-1 min-w-[200px] max-w-xl" />
    {selected.size > 0 && (
      <>
        <button
          onClick={() => setShowBulkEdit(true)}
          className="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors border border-blue-100"
        >
          <span>✎ Изменить</span>
          <span className="bg-blue-200 px-1.5 py-0.5 rounded text-[10px]">{selected.size}</span>
        </button>
        <button
          onClick={handleCopySelected}
          className="flex items-center gap-1.5 bg-orange-50 text-orange-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-orange-100 transition-colors border border-orange-100"
        >
          <span>📄 Копировать</span>
          <span className="bg-orange-200 px-1.5 py-0.5 rounded text-[10px]">{selected.size}</span>
        </button>
      </>
    )}
  </div>
  <div className="flex items-center gap-2">
    <button
      onClick={() => setShowNotes(v => !v)}
      title={showNotes ? 'Скрыть примечания' : 'Показать примечания'}
      className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
        showNotes
          ? 'bg-blue-50 border-blue-200 text-blue-700'
          : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
      }`}
    >
      💬 Примечания
    </button>
    <button
      onClick={() => { setEditOperation(null); setShowForm(true) }}
      className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors"
    >
      + Добавить
    </button>
  </div>
</div>

        {/* Фильтры */}
        <div className="px-6 py-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <PeriodPicker value={period} onChange={setPeriod} allowAll />
            <span className="text-gray-300">|</span>
            <div className="flex items-center gap-4 flex-wrap">
  {projects.length > 1 && (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 font-medium">Проект:</span>
      <select
        value={filter.project_id}
        onChange={e => setFilter(f => ({ ...f, project_id: e.target.value }))}
        className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48"
      >
        <option value="">Все проекты</option>
        {projects.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </div>
  )}
  <div className="flex items-center gap-2">
    <span className="text-xs text-gray-500 font-medium">Аналитика:</span>
    <select 
      value={infoType} 
      onChange={e => setInfoType(e.target.value)}
      className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <option value="">Тип не выбран</option>
      <option value="partner">Контрагенты</option>
      <option value="product">Товары</option>
      <option value="cash">Кассы</option>
      <option value="employee">Сотрудники</option>
    </select>
  </div>

  {infoType && (
    <div className="flex items-center gap-2">
      <select 
        value={selectedInfoId} 
        onChange={e => setSelectedInfoId(e.target.value)}
        className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48"
      >
        <option value="">Все элементы {infoType}</option>
        {infoOptions.map(opt => (
          <option key={opt.id} value={opt.id}>{opt.name}</option>
        ))}
      </select>
    </div>
  )}
</div>
            {/* Действующий поиск — среди фильтров: он такой же отбор,
                как период или счёт, и снимается там же */}
            <SearchBadge q={q} found={totalCount} onClear={() => setQ('')} />
            <BusyLabel active={loading}>Загружаю операции</BusyLabel>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Дебет:</span>
              <select value={filter.in_bi_id}
                onChange={e => setFilter(f => ({ ...f, in_bi_id: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48">
                <option value="">Все счета</option>
                {balanceItems.map(item => (
                  <option key={item.id} value={item.id}>{item.code} — {item.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Кредит:</span>
              <select value={filter.out_bi_id}
                onChange={e => setFilter(f => ({ ...f, out_bi_id: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-48">
                <option value="">Все счета</option>
                {balanceItems.map(item => (
                  <option key={item.id} value={item.id}>{item.code} — {item.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Проведение:</span>
              <select value={filter.is_posted}
                onChange={e => setFilter(f => ({ ...f, is_posted: e.target.value }))}
                className="px-3 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Все</option>
                <option value="1">Проведённые</option>
                <option value="0">Непроведённые</option>
              </select>
            </div>
            {(filter.in_bi_id || filter.out_bi_id) && (
              <button onClick={() => setFilter(f => ({ ...f, in_bi_id: '', out_bi_id: '' }))}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                × сбросить
              </button>
            )}
          </div>
        </div>

        {loading && operations.length === 0 ? (
          // Первый заход или смена периода с нуля: карточек ещё нет, но список
          // уже «занимает место» — экран не выглядит пустым и сломанным
          <div className="px-4 pt-3 pb-4 bg-gray-50/60 rounded-b-xl">
            <SkeletonRows rows={7} height="h-16" />
          </div>
        ) : operations.length === 0 ? (
          <div className="text-center py-12">
            {q ? (
              <>
                <p className="text-gray-400 mb-1">По запросу «{q}» ничего не найдено</p>
                <p className="text-xs text-gray-400 mb-4">
                  Поиск идёт в пределах периода и остальных фильтров — возможно, дело в них
                </p>
                <button onClick={() => setQ('')} className="text-blue-600 hover:underline text-sm">
                  Очистить поиск
                </button>
              </>
            ) : (
              <>
                <p className="text-gray-400 mb-4">Нет операций за выбранный период</p>
                <button onClick={() => setShowForm(true)} className="text-blue-600 hover:underline text-sm">
                  Добавить операцию
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="relative overflow-x-auto px-4 pt-3 pb-4 bg-gray-50/60 rounded-b-xl">
            {/* Перезагрузка списка при смене фильтра: старые карточки ещё видны */}
            <BusyOverlay active={loading}
              label="Обновляю список"
              hint="Долго — сузьте период или добавьте фильтр по счёту" />
            <div className="min-w-[1050px]">
              {/* Шапка колонок */}
              <div className={`${OP_GRID} items-center px-4 pb-2 text-xs text-gray-500 uppercase tracking-wide`}>
                <div>
                  <input type="checkbox" checked={allChecked}
                    ref={el => { if (el) el.indeterminate = someChecked }}
                    onChange={toggleAll} className="rounded" />
                </div>
                <div>#</div>
                <div>Дата</div>
                <div>Дебет</div>
                <div>Кредит</div>
                <div className="text-right">Сумма</div>
                <div>Содержание</div>
                <div></div>
              </div>

              {/* Карточки операций */}
              <div className="space-y-2">
                {operations.map(op => (
                  <div key={op.id}
                    onClick={() => toggleSelect(op.id)}
                    // Двойной клик открывает саму операцию — в том числе
                    // созданную документом: в ней смотрят движения по счетам.
                    // В документ ведёт своя иконка, и он открывается тут же,
                    // не уводя со списка
                    onDoubleClick={() => handleEdit(op)}
                    title="Двойной клик — открыть операцию"
                    // Непроведённая — пунктиром и приглушённая: она в списке
                    // есть, а в оборотах её нет, и это должно быть видно сразу
                    className={`px-4 py-3 rounded-xl border cursor-pointer select-none transition-all group ${
                      selected.has(op.id)
                        ? 'border-orange-200 bg-orange-50 ring-1 ring-orange-200'
                        : op.is_posted === false
                          ? 'border-dashed border-gray-300 bg-gray-50 hover:border-blue-300'
                          : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'
                    }`}
                  >
                    <div className={`${OP_GRID} items-start`}>
                    <div onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(op.id)}
                        onChange={() => toggleSelect(op.id)} className="rounded" />
                    </div>
                    <div className="text-xs text-gray-400 font-mono pt-0.5">
                      <span className={qId === op.id ? hitCell : ''}>{op.id}</span>
                    </div>
                    <div className="text-sm text-gray-600 whitespace-nowrap pt-0.5">{formatDate(op.date)}</div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <AccountChip code={op.in_bi_code} name={op.in_bi_name} hidden={op.in_hidden} side="debit" q={q} />
                      </div>
                      {op.in_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500"><Highlight text={op.in_info_1_name} q={q} /></span> <span className="text-gray-300">#{op.in_info_1_id}</span></div>}
                      {op.in_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500"><Highlight text={op.in_info_2_name} q={q} /></span> <span className="text-gray-300">#{op.in_info_2_id}</span></div>}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <AccountChip code={op.out_bi_code} name={op.out_bi_name} hidden={op.out_hidden} side="credit" q={q} />
                      </div>
                      {op.out_info_1_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500"><Highlight text={op.out_info_1_name} q={q} /></span> <span className="text-gray-300">#{op.out_info_1_id}</span></div>}
                      {op.out_info_2_name && <div className="text-xs text-gray-400 mt-0.5">↳ <span className="text-gray-500"><Highlight text={op.out_info_2_name} q={q} /></span> <span className="text-gray-300">#{op.out_info_2_id}</span></div>}
                    </div>
                    <div className="text-right whitespace-nowrap pt-0.5">
                      <div className={`font-semibold ${op.is_posted === false ? 'text-gray-400' : 'text-gray-800'}`}>
                        <span className={qAmount !== null && Math.abs(Number(op.amount) - qAmount) < 0.005 ? hitCell : ''}>
                          {formatAmount(op.amount)}
                        </span>
                      </div>
                      {op.is_posted === false && (
                        <div className="text-[10px] text-gray-500 bg-gray-200 rounded px-1 mt-0.5 inline-block">
                          не проведена
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      {op.content
                        ? <div className="text-xs text-gray-700 line-clamp-2 break-words" title={op.content}>
                            <Highlight text={snippet(op.content, q)} q={q} />
                          </div>
                        : (!showNotes || !op.note) && <span className="text-gray-300">—</span>}

                      {/* Примечание — сразу под содержанием. Не обрезаем в одну
                          строку: в нём реквизиты контрагента из выписки */}
                      {showNotes && op.note && (
                        <div
                          // ИНН и р/с нужно уметь скопировать; выделил текст —
                          // карточка не переключается
                          onClick={e => { if (!window.getSelection()?.isCollapsed) e.stopPropagation() }}
                          title={op.note}
                          className={`flex items-start gap-1 text-[11px] text-gray-400 leading-snug
                                      select-text cursor-auto ${op.content ? 'mt-1' : ''}`}>
                          <span className="text-gray-300 flex-shrink-0 select-none">💬</span>
                          <span className="break-words line-clamp-3"><Highlight text={snippet(op.note, q)} q={q} /></span>
                        </div>
                      )}
                    </div>
                    <div className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {op.table_name === 'documents' && op.table_id ? (
                          <>
                            <button onClick={() => openDocument(op.table_id)} title="Открыть документ-источник"
                              className="text-blue-400 hover:text-blue-600 p-1 rounded hover:bg-blue-50">📄</button>
                            <button onClick={() => handleEdit(op)} title="Открыть операцию"
                              className="text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50">
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => togglePosting(op)}
                              title={op.is_posted === false ? 'Провести — попадёт в обороты' : 'Снять проведение — уйдёт из оборотов'}
                              className={op.is_posted === false
                                ? 'text-gray-400 hover:text-green-600 p-1 rounded hover:bg-green-50'
                                : 'text-gray-300 hover:text-gray-600 p-1 rounded hover:bg-gray-100'}>
                              {op.is_posted === false ? '✓' : '⊘'}
                            </button>
                            <button onClick={() => copyOp(op)}
                              title="Скопировать операцию"
                              className="text-gray-300 hover:text-blue-600 p-1 rounded hover:bg-blue-50">
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            </button>
                            <button onClick={() => templateFromOp(op)} className="text-gray-300 hover:text-amber-500 p-1 rounded hover:bg-amber-50" title="Сохранить как шаблон">
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1L12 2z"/></svg>
                            </button>
                            <button onClick={() => handleEdit(op)} className="text-gray-300 hover:text-gray-500 p-1 rounded hover:bg-gray-50" title="Редактировать"><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                            <button onClick={() => handleDelete(op.id)} className="text-gray-400 hover:text-red-500 text-base p-1 rounded hover:bg-red-50">×</button>
                          </>
                        )}
                      </div>
                    </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Сколько показано из найденного. Прежде список обрывался на
                  двухсотой операции молча, и период выглядел меньше, чем есть */}
              <div className="flex items-center justify-center gap-3 pt-4 text-xs text-gray-500">
                <span>
                  Показано {operations.length} из {totalCount}
                </span>
                {hasMore && (
                  <button onClick={loadMore} disabled={loadingMore}
                    className="px-3 py-1.5 border border-gray-200 bg-white rounded-lg text-xs font-medium text-blue-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-40">
                    {loadingMore
                      ? 'Загружаю…'
                      : `Показать ещё ${Math.min(PER_PAGE, totalCount - operations.length)}`}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Обороты по счетам — под таблицей. Считаются по всему отбору,
          а не по показанным строкам */}
      {accountTotals.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
          <div className="px-6 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-800">Обороты по счетам</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-50">
                  <th className="text-left px-6 py-2">Счёт</th>
                  <th className="text-right px-6 py-2 text-green-600">Дебет</th>
                  <th className="text-right px-6 py-2 text-red-500">Кредит</th>
                  <th className="text-right px-6 py-2 text-gray-500">Сальдо</th>
                </tr>
              </thead>
              <tbody>
                {accountTotals.map(acc => (
                  <tr key={acc.code} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-6 py-2">
                      {acc.hidden
                        ? <span className="text-xs text-gray-400 inline-flex items-center gap-1.5"><LockIcon className="w-3 h-3" />Счета, закрытые для вашей должности</span>
                        : <>
                            <span className="text-xs font-mono font-medium text-gray-700 mr-2">{acc.code}</span>
                            <span className="text-xs text-gray-400">{acc.name}</span>
                          </>}
                    </td>
                    <td className="px-6 py-2 text-right text-xs font-medium text-green-600 whitespace-nowrap">
                      {acc.debit > 0 ? formatAmount(acc.debit) : '—'}
                    </td>
                    <td className="px-6 py-2 text-right text-xs font-medium text-red-500 whitespace-nowrap">
                      {acc.credit > 0 ? formatAmount(acc.credit) : '—'}
                    </td>
                    <td className="px-6 py-2 text-right text-xs font-medium text-gray-700 whitespace-nowrap">
                      {formatAmount(acc.debit - acc.credit)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td className="px-6 py-2 text-xs font-semibold text-gray-600">Итого</td>
                  <td className="px-6 py-2 text-right text-xs font-bold text-green-600 whitespace-nowrap">
                    {formatAmount(accountTotals.reduce((s, a) => s + a.debit, 0))}
                  </td>
                  <td className="px-6 py-2 text-right text-xs font-bold text-red-500 whitespace-nowrap">
                    {formatAmount(accountTotals.reduce((s, a) => s + a.credit, 0))}
                  </td>
                  <td className="px-6 py-2 text-right text-xs font-bold text-gray-700 whitespace-nowrap">
                    {formatAmount(accountTotals.reduce((s, a) => s + (a.debit - a.credit), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <OperationForm
          operation={editOperation}
          initial={draftOperation}
          onOpenDocument={(id) => { handleFormClose(); openDocument(id) }}
          onSuccess={() => { handleFormClose(); reload() }}
          onCancel={handleFormClose}
        />
      )}

      {docError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg shadow-lg">
          {docError}
        </div>
      )}

      {/* Документ-источник — сразу в правке, поверх списка операций */}
      {docModal && (
        <DocumentForm
          docType={docModal.doc.type}
          doc={docModal.doc}
          balanceItems={balanceItems}
          infoCache={docInfoCache}
          loadInfo={loadDocInfo}
          onSave={() => { setDocModal(null); reload() }}
          onCancel={() => setDocModal(null)}
          onChanged={loadOperations}
        />
      )}

      {showBulkEdit && (
        <BulkEditOperations
          ids={[...selected]}
          balanceItems={balanceItems}
          projects={projects}
          onClose={() => setShowBulkEdit(false)}
          onApplied={loadOperations}
        />
      )}
    </Layout>
  )
}
