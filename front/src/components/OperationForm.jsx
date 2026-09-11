import { useState, useEffect } from 'react'
import { getBalanceItems, createOperation, updateOperation } from '../api/operations'
import { getInfo } from '../api/info'
import { getProjects } from '../api/projects'
import AmountInput from './AmountInput'
import OperationChanges from './OperationChanges'
import SharedInfoSelect from './InfoSelect'
import { BusyLabel } from './Busy'
import LockIcon from './LockIcon'

const INFO_LABELS = {
  partner:    'Контрагент',
  product:    'Товар/Услуга',
  cash:       'Касса/Счёт',
  employee:   'Сотрудник',
  revenue:    'Статья дохода',
  expenses:   'Статья расхода',
  department: 'Отдел',
  flow:       'Статья движения',
}

// Выбор аналитики.
//
// Раньше здесь жила своя копия выпадающего списка со своей формой создания —
// более старая, чем в документах, и уже разошедшаяся с ней: не было ни поиска
// по ИНН, ни недавних. Теперь общий компонент, а от прежней копии осталась
// только подпись поля.
const SearchableInfoSelect = ({ items, value, onChange, label, infoType, onItemCreated }) => (
  <SharedInfoSelect
    items={items}
    value={value}
    onChange={onChange}
    label={label}
    infoType={infoType}
    // Кэш справочников на форме разложен по типам, а общий компонент про этот
    // кэш не знает — тип подставляем здесь
    onItemCreated={(item, replacedId) => onItemCreated?.(infoType, item, replacedId)}
  />
)

// `operation` — редактирование существующей; `initial` — предзаполнение новой (черновик ИИ)
export default function OperationForm({ operation, initial, onSuccess, onCancel, onOpenDocument }) {
  const [tab, setTab] = useState('fields')   // 'fields' | 'changes'
  const isEdit = !!(operation && operation.id)
  // Операцию, рождённую документом, сервер править не даст — и правильно:
  // документ пересоздаёт свои проводки при каждом проведении
  const fromDocument = !!(operation?.table_name === 'documents' && operation?.table_id)
  // Одна из сторон закрыта должностью. Сервер такую правку не примет: форма
  // сохранила бы то, чего человеку не показывали
  const hasHidden = !!(operation?.in_hidden || operation?.out_hidden)
  const locked = fromDocument || hasHidden
  const src = operation || initial || null
  const [balanceItems, setBalanceItems] = useState([])
  const [projects, setProjects] = useState([])
  const [infoCache, setInfoCache] = useState({})
  const [loading, setLoading] = useState(false)
  // Справочники формы (проекты, план счетов, аналитика выбранных счетов):
  // на своей базе они приходят не мгновенно, а до их прихода поля пустые
  const [dictLoading, setDictLoading] = useState(true)
  const [error, setError] = useState('')
  // Режим формы: 'classic' (в столбик) | 'wide' (дебет/кредит рядом). Запоминаем выбор.
  const [layout, setLayout] = useState(() => localStorage.getItem('op_form_layout') || 'wide')
  const changeLayout = (v) => { setLayout(v); localStorage.setItem('op_form_layout', v) }
  // Локальное время для datetime-local input без UTC-конвертации
  const localNow = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  // Черновик ИИ приходит с датой без времени (YYYY-MM-DD) — дополняем текущим временем
  const toLocalInput = (d) => {
    if (!d) return localNow()
    const s = String(d).replace(' ', 'T')
    return s.length <= 10 ? `${s}T${localNow().slice(11)}` : s.slice(0, 16)
  }

  const [form, setForm] = useState({
    date:          src ? toLocalInput(src.date) : localNow(),
    project_id:    src?.project_id ?? '',
    amount:        src?.amount ?? '',
    in_bi_id:      src?.in_bi_id ?? '',
    out_bi_id:     src?.out_bi_id ?? '',
    in_info_1_id:  src?.in_info_1_id ?? '',
    in_info_2_id:  src?.in_info_2_id ?? '',
    out_info_1_id: src?.out_info_1_id ?? '',
    out_info_2_id: src?.out_info_2_id ?? '',
    // Третий слот форма не редактирует, но держит: иначе обмен сторон
    // поменял бы местами только первые две аналитики, а третья осталась бы
    // на чужом счёте
    in_info_3_id:  src?.in_info_3_id ?? '',
    out_info_3_id: src?.out_info_3_id ?? '',
    // Количество — своё у каждой стороны: в отчёты оно попадает только со
    // счёта, у которого включён количественный учёт. Копия старой операции
    // приходит с общим quantity — раскладываем его на обе стороны
    in_quantity:   src?.in_quantity  ?? src?.quantity ?? '',
    out_quantity:  src?.out_quantity ?? src?.quantity ?? '',
    content:       src?.content ?? '',
    note:          src?.note ?? '',
    // Новая операция проводится сразу — иначе её пришлось бы проводить
    // вторым действием, а это норма, а не исключение
    is_posted:     src ? src.is_posted !== false : true,

    })

  useEffect(() => {
    const projectsLoaded = getProjects().then(res => {
      const list = res.data.data || []
      setProjects(list)
      // При создании операции — подставляем первый проект, если ещё не выбран.
      if (!isEdit && list.length > 0) {
        setForm(f => (f.project_id ? f : { ...f, project_id: list[0].id }))
      }
    })

    const itemsLoaded = getBalanceItems().then(res => {
      const items = res.data.data
      setBalanceItems(items)

      if (src) {
        const inBi  = items.find(b => b.id == src.in_bi_id)
        const outBi = items.find(b => b.id == src.out_bi_id)
        const types = [...new Set([
          inBi?.info_1_type, inBi?.info_2_type,
          outBi?.info_1_type, outBi?.info_2_type,
        ].filter(Boolean))]

        // Ждём и справочники аналитики: пока их нет, поля выбранного
        // контрагента и статьи стоят пустыми, и форма выглядит недозаполненной
        return Promise.allSettled(types.map(type =>
          getInfo({ type }).then(r => {
            setInfoCache(prev => ({ ...prev, [type]: r.data.data }))
          })
        ))
      }
    })

    Promise.allSettled([projectsLoaded, itemsLoaded]).then(() => setDictLoading(false))
  }, [])

  const loadInfoForBi = (biId, prevCache) => {
    const bi = balanceItems.find(b => b.id == biId)
    const types = [bi?.info_1_type, bi?.info_2_type].filter(Boolean)
    types.forEach(type => {
      if (!prevCache[type]) {
        getInfo({ type }).then(r => {
          setInfoCache(prev => ({ ...prev, [type]: r.data.data }))
        })
      }
    })
  }

  // Callback для inline-создания: добавляем элемент в кеш
  // Callback для inline-создания/редактирования: добавляем или обновляем элемент в кеше
  const handleItemCreated = (type, newItem, replaceId = null) => {
    setInfoCache(prev => {
      const list = prev[type] || []
      if (replaceId) {
        return { ...prev, [type]: list.map(i => i.id == replaceId ? newItem : i) }
      }
      return { ...prev, [type]: [...list, newItem] }
    })
  }

  const inBi  = balanceItems.find(b => b.id == form.in_bi_id)
  const outBi = balanceItems.find(b => b.id == form.out_bi_id)

  /**
   * Ввод количества.
   *
   * Когда количественный учёт с обеих сторон (передача между сотрудниками,
   * перемещение между складами), количество почти всегда одно и то же —
   * поэтому вторая сторона повторяет первую, пока её не правили руками.
   * Тронули вторую отдельно — она отвязывается и живёт своей жизнью:
   * бывает и так, что списывают 10, а приходуют 9.
   */
  const bothHaveQty = !!(inBi?.has_quantity && outBi?.has_quantity)

  const setQuantity = (side, value) => setForm(f => {
    const mine  = side === 'in' ? 'in_quantity'  : 'out_quantity'
    const other = side === 'in' ? 'out_quantity' : 'in_quantity'
    const linked = bothHaveQty && (f[other] === '' || f[other] === f[mine])
    return { ...f, [mine]: value, ...(linked ? { [other]: value } : {}) }
  })

  const quantityField = (side, bi) => bi?.has_quantity && (
    <div>
      <label className={lc}>Количество ({bi.code})</label>
      <AmountInput
        value={side === 'in' ? form.in_quantity : form.out_quantity}
        onChange={(v) => setQuantity(side, v)}
        placeholder="0" className={`${ic} text-right`} />
    </div>
  )

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const payload = { ...form }
      // Пустое поле количества — это ноль, а не «не трогать»: иначе снятое
      // количество осталось бы в базе от прошлой правки
      payload.in_quantity  = parseFloat(payload.in_quantity)  || 0
      payload.out_quantity = parseFloat(payload.out_quantity) || 0
      if (payload.date) {
        // Дата операции хранится и сравнивается как локальная «настенная»:
        // такой её пишет импорт выписки, по такой фильтрует список и по такой
        // же проверяется запрет закрытого периода. Перевод в UTC здесь сдвигал
        // операцию на смещение пояса — у полуночных строк из выписки на сутки
        // назад, вплоть до попадания в закрытый период. Отдаём как есть.
        const s = String(payload.date).replace('T', ' ')
        payload.date = s.length === 16 ? `${s}:00` : s.slice(0, 19)
      }
      // Номер операции нужен помощнику: он подписывает им записанный черновик,
      // чтобы по диалогу было видно, что из него вышло. Остальные вызывающие
      // лишний аргумент просто не читают
      const res = isEdit
        ? await updateOperation(operation.id, payload)
        : await createOperation(payload)

      onSuccess(res?.data?.data?.id ?? operation?.id ?? null)
    } catch (err) {
      const errors = err.response?.data?.errors
      setError(errors ? Object.values(errors).flat().join(', ') : err.response?.data?.message || 'Ошибка')
    } finally {
      setLoading(false)
    }
  }

  const ic = "w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
  const lc = "block text-sm font-medium text-gray-700 mb-1"

  const debitFields = (
    <>
      <div>
        <label className={lc}>Дебет (куда)</label>
        <select value={form.in_bi_id}
          onChange={e => {
            setForm({...form, in_bi_id: e.target.value, in_info_1_id: '', in_info_2_id: ''})
            loadInfoForBi(e.target.value, infoCache)
          }}
          className={ic} required>
          <option value="">{dictLoading ? 'Загружаю план счетов...' : 'Выберите счёт...'}</option>
          {balanceItems.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}
        </select>
      </div>
      {inBi?.info_1_type && (
        <SearchableInfoSelect items={infoCache[inBi.info_1_type]} value={form.in_info_1_id}
          onChange={(val) => setForm({...form, in_info_1_id: val})}
          label={`${INFO_LABELS[inBi.info_1_type]} (${inBi.code})`} infoType={inBi.info_1_type} onItemCreated={handleItemCreated} />
      )}
      {inBi?.info_2_type && (
        <SearchableInfoSelect items={infoCache[inBi.info_2_type]} value={form.in_info_2_id}
          onChange={(val) => setForm({...form, in_info_2_id: val})}
          label={`${INFO_LABELS[inBi.info_2_type]} (${inBi.code})`} infoType={inBi.info_2_type} onItemCreated={handleItemCreated} />
      )}
      {quantityField('in', inBi)}
    </>
  )

  const creditFields = (
    <>
      <div>
        <label className={lc}>Кредит (откуда)</label>
        <select value={form.out_bi_id}
          onChange={e => {
            setForm({...form, out_bi_id: e.target.value, out_info_1_id: '', out_info_2_id: ''})
            loadInfoForBi(e.target.value, infoCache)
          }}
          className={ic} required>
          <option value="">{dictLoading ? 'Загружаю план счетов...' : 'Выберите счёт...'}</option>
          {balanceItems.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}
        </select>
      </div>
      {outBi?.info_1_type && (
        <SearchableInfoSelect items={infoCache[outBi.info_1_type]} value={form.out_info_1_id}
          onChange={(val) => setForm({...form, out_info_1_id: val})}
          label={`${INFO_LABELS[outBi.info_1_type]} (${outBi.code})`} infoType={outBi.info_1_type} onItemCreated={handleItemCreated} />
      )}
      {outBi?.info_2_type && (
        <SearchableInfoSelect items={infoCache[outBi.info_2_type]} value={form.out_info_2_id}
          onChange={(val) => setForm({...form, out_info_2_id: val})}
          label={`${INFO_LABELS[outBi.info_2_type]} (${outBi.code})`} infoType={outBi.info_2_type} onItemCreated={handleItemCreated} />
      )}
      {quantityField('out', outBi)}
    </>
  )

  const contentField = (
    <div>
      <label className={lc}>Содержание</label>
      <input type="text" value={form.content ?? ''} onChange={e => setForm({...form, content: e.target.value})}
        placeholder="Назначение платежа, описание проводки" className={ic} />
    </div>
  )

  const commentField = (
    <div>
      <label className={lc}>Комментарий</label>
      <input type="text" value={form.note} onChange={e => setForm({...form, note: e.target.value})}
        placeholder="Необязательно" className={ic} />
    </div>
  )

  /**
   * Поменять дебет и кредит местами — вместе с аналитикой.
   *
   * Аналитика едет за своим счётом: она осмысленна только в паре с ним,
   * оставить её на месте значило бы приписать контрагента чужому счёту.
   */
  const swapSides = () => setForm(f => ({
    ...f,
    in_bi_id:      f.out_bi_id,
    out_bi_id:     f.in_bi_id,
    in_info_1_id:  f.out_info_1_id,
    in_info_2_id:  f.out_info_2_id,
    in_info_3_id:  f.out_info_3_id,
    out_info_1_id: f.in_info_1_id,
    out_info_2_id: f.in_info_2_id,
    out_info_3_id: f.in_info_3_id,
    // Количество едет за своей стороной вместе со счётом и аналитикой
    in_quantity:   f.out_quantity,
    out_quantity:  f.in_quantity,
  }))

  const swapButton = (
    <button type="button" onClick={swapSides}
      title="Поменять дебет и кредит местами вместе с аналитикой"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-gray-200
                 text-xs text-gray-600 hover:bg-gray-50 hover:text-blue-700 transition-colors">
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 2l4 4-4 4" /><path d="M3 6h18" /><path d="M7 22l-4-4 4-4" /><path d="M21 18H3" />
      </svg>
      Поменять местами
    </button>
  )

  const postingField = (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="checkbox" className="w-4 h-4 accent-blue-900 mt-0.5"
        checked={form.is_posted !== false}
        onChange={e => setForm({ ...form, is_posted: e.target.checked })} />
      <span>
        <span className="text-sm text-gray-700">Проведена</span>
        <span className="block text-[11px] text-gray-400">
          Непроведённая операция остаётся в списке, но не попадает в обороты и отчёты
        </span>
      </span>
    </label>
  )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className={`bg-white rounded-2xl shadow-xl w-full my-4 ${layout === 'wide' ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="p-6 border-b border-gray-100 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-4 flex-wrap">
            <h3 className="text-lg font-semibold text-gray-800">
              {isEdit ? 'Редактировать операцию' : 'Новая операция'}
            </h3>
            {/* Форма открывается сразу, а справочники подтягиваются следом:
                видно, что поля ещё наполняются, а не пусты по существу */}
            <BusyLabel active={dictLoading}>Загружаю справочники</BusyLabel>
            {/* Движения есть только у сохранённой операции — их порождает триггер */}
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
          <div className={`items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 text-xs flex-shrink-0 ${
            tab === 'changes' ? 'hidden' : 'flex'
          }`}>
            <button type="button" onClick={() => changeLayout('classic')}
              className={`px-2.5 py-1 rounded-md transition-colors ${layout === 'classic' ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-700'}`}>
              В столбик
            </button>
            <button type="button" onClick={() => changeLayout('wide')}
              className={`px-2.5 py-1 rounded-md transition-colors ${layout === 'wide' ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-700'}`}>
              Рядом
            </button>
          </div>
        </div>

        {tab === 'changes' ? (
          <div className="p-6 space-y-4">
            <OperationChanges operationId={operation.id} />
            <div className="flex justify-end pt-2">
              <button type="button" onClick={onCancel}
                className="px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
                Закрыть
              </button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

          {/* Операция из документа: реквизиты правятся только в нём, иначе
              документ и его проводки разъехались бы. Поля показываем, но
              выключаем — смотреть можно, менять нельзя */}
          {fromDocument && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
              <span className="text-base leading-none">📄</span>
              <span>
                Операция создана документом — реквизиты меняются в нём.
                {onOpenDocument && (
                  <button type="button" onClick={() => onOpenDocument(operation.table_id)}
                    className="ml-1 underline hover:no-underline font-medium">
                    Открыть документ
                  </button>
                )}
                <span className="block text-[11px] text-amber-700 mt-0.5">
                  Движения по счетам видны на соседней вкладке.
                </span>
              </span>
            </div>
          )}

          {hasHidden && (
            <div className="bg-gray-50 border border-gray-200 text-gray-700 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
              <LockIcon className="w-4 h-4 mt-0.5 text-gray-400" />
              <span>
                В операции есть счёт, закрытый для вашей должности — она доступна только для чтения.
                <span className="block text-[11px] text-gray-500 mt-0.5">
                  Сумма и дата видны, счёт и аналитика закрытой стороны — нет.
                </span>
              </span>
            </div>
          )}

          <fieldset disabled={locked} className="contents">

          {projects.length > 1 && (
            <div>
              <label className={lc}>Проект</label>
              <select value={form.project_id}
                onChange={e => setForm({...form, project_id: e.target.value})}
                className={ic} required>
                <option value="">Выберите проект...</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lc}>Дата и время</label>
              <input type="datetime-local" value={form.date}
                onChange={e => setForm({...form, date: e.target.value})}
                className={ic} required />
            </div>
            <div>
              <label className={lc}>Сумма (₽)</label>
              <AmountInput value={form.amount}
                onChange={v => setForm({...form, amount: v})}
                placeholder="0,00" className={`${ic} text-right`} required />
            </div>
          </div>

          {/* Содержание — вверху на всю ширину (только в режиме «рядом») */}
          {layout === 'wide' && contentField}

          {/* Дебет / Кредит — рядом (wide) или в столбик (classic) */}
          <div className="flex justify-end">{swapButton}</div>
          {layout === 'wide' ? (
            <div className="grid grid-cols-2 border border-gray-200 rounded-xl">
              <div className="p-4 space-y-3 border-r border-gray-200 bg-green-50/40 rounded-l-xl">{debitFields}</div>
              <div className="p-4 space-y-3 bg-red-50/30 rounded-r-xl">{creditFields}</div>
            </div>
          ) : (
            <div className="space-y-4">{debitFields}{creditFields}</div>
          )}

          {/* Комментарий (рядом) / Содержание+Комментарий (в столбик) */}
          {layout === 'wide' ? commentField : (
            <div className="space-y-4">{contentField}{commentField}</div>
          )}

          {postingField}

          </fieldset>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onCancel}
              className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
              {locked ? 'Закрыть' : 'Отмена'}
            </button>
            {!locked && (
              <button type="submit" disabled={loading}
                className="flex-1 px-4 py-2.5 bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50 text-sm font-medium">
                {loading ? 'Сохранение...' : isEdit ? 'Обновить' : 'Сохранить'}
              </button>
            )}
          </div>
        </form>
        )}
      </div>
    </div>
  )
}
