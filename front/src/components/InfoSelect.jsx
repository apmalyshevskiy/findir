import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import InfoItemCard from './InfoItemCard'
import { INFO_LABELS } from '../utils/infoLabels'
import { matchesSearch, Highlight } from '../utils/infoSearch'
import { pushRecent, recentItems } from '../utils/recentInfo'

/**
 * Выбор элемента справочника: поиск, дерево, недавние, создание на месте.
 *
 * Один компонент на все экраны. До него выбор справочника был написан заново
 * четырежды — в документах, операциях, банковской выписке и справочниках, — и
 * копии разошлись: где-то был поиск по ИНН, где-то карандаш, где-то ни того ни
 * другого. Любая правка стоила четырёх правок, поэтому её обычно не делали.
 *
 * Недавние показываем, но не подставляем: см. utils/recentInfo.js.
 *
 * Список рисуем порталом в body. Без этого он обрезается краем прокручиваемой
 * таблицы — а именно в таблицах документов им и пользуются.
 */

const buildTree = (items) => {
  const map = {}, roots = []

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

const flatten = (nodes, depth = 0) => {
  let out = []
  nodes.forEach(n => {
    out.push({ ...n, depth })
    if (n.children?.length) out = out.concat(flatten(n.children, depth + 1))
  })
  return out
}

export default function InfoSelect({
  items,
  value,
  onChange,
  infoType,
  placeholder = 'Выбрать...',
  emptyLabel = '',
  label = '',
  hint = '',
  disabled = false,
  allowClear = true,
  onItemCreated,
  className = '',
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen]     = useState(false)
  const [pos, setPos]       = useState({ top: 0, left: 0, width: 240 })
  const [card, setCard]     = useState(null)   // null | 'create' | 'edit'

  const inputRef = useRef(null)
  const dropRef  = useRef(null)

  // Справочник ещё не пришёл: значение в операции есть, а имени для него нет.
  // Пустое поле в этот момент читается как «аналитика не заполнена»
  const loading = items === undefined
  const list    = items || []

  // Заводить и править элементы можно, только если известен их тип
  const editable = !!infoType && !disabled

  useEffect(() => {
    const away = (e) => {
      if (
        inputRef.current && !inputRef.current.contains(e.target) &&
        !(dropRef.current && dropRef.current.contains(e.target))
      ) setOpen(false)
    }

    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  /**
   * Позиция списка.
   *
   * Список рисуется порталом с `position: fixed`, поэтому координаты берём
   * относительно окна — без прибавки прокрутки. С ней список уезжал вниз ровно
   * на прокрученную высоту: в модальном окне документа это не проявлялось,
   * потому что там `window.scrollY` всегда ноль, а на длинной странице выписки
   * проявилось бы сразу.
   */
  const place = () => {
    if (!inputRef.current) return

    const r = inputRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 260) })
  }

  // Пока список открыт, он должен держаться поля: страница под ним прокручивается
  useEffect(() => {
    if (!open) return

    const follow = (e) => {
      // Прокрутка внутри самого списка поле не двигает
      if (dropRef.current && e.target !== document && dropRef.current.contains(e.target)) return
      place()
    }

    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)

    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])

  const focus = () => {
    if (disabled) return

    place()
    setOpen(true)
    setSearch('')
  }

  const selected = list.find(i => String(i.id) === String(value))
  const filtered = flatten(buildTree(list)).filter(i => matchesSearch(i, search))

  // Недавние — только пока не начали печатать: при поиске нужен весь
  // справочник, а не короткий список того, что попадалось раньше
  const recent = !search && infoType ? recentItems(infoType, list).filter(i => String(i.id) !== String(value)) : []

  const pick = (id) => {
    pushRecent(infoType, id)
    onChange(id)
    setOpen(false)
    setSearch('')
  }

  // InfoItemCard отдаёт вторым аргументом id заменённого элемента (при правке).
  // Передаём дальше: страницам он нужен, чтобы обновить элемент в кэше, а не
  // добавить рядом второй такой же
  const saved = (item, replacedId) => {
    onItemCreated?.(item, replacedId)
    pushRecent(infoType, item.id)
    onChange(item.id)
    setCard(null)
    setSearch('')
    setOpen(false)
  }

  const keys = (e) => {
    if (e.key === 'Escape') { setOpen(false); setSearch(''); return }

    // Enter выбирает, только когда вариант ровно один: угадывать за человека
    // при нескольких совпадениях — верный способ поставить не ту аналитику
    if (e.key === 'Enter' && search && filtered.length === 1) {
      e.preventDefault()
      pick(filtered[0].id)
    }
  }

  const row = (i, key) => (
    <div key={key}
      className="px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 flex items-center gap-1"
      style={{ paddingLeft: 12 + (i.depth || 0) * 14 }}
      onMouseDown={() => pick(i.id)}>
      {i.depth > 0 && <span className="text-gray-300 text-xs">└</span>}
      <span className={i.depth === 0 ? 'font-medium text-gray-800' : 'text-gray-600'}>
        <Highlight text={i.name} q={search} />
      </span>
      {i.code && <span className="ml-auto text-xs text-gray-400 shrink-0">{i.code}</span>}
    </div>
  )

  return (
    <div className={`relative ${className}`}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
          {hint && <span className="ml-1 text-xs text-gray-400 font-normal">{hint}</span>}
        </label>
      )}

      <input
        ref={inputRef}
        type="text"
        disabled={disabled}
        className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
          disabled ? 'bg-gray-50 text-gray-400 cursor-not-allowed' : 'bg-white border-gray-200'
        } ${editable && value ? 'pr-12' : ''}`}
        placeholder={loading && value ? 'Загружаю…' : (selected ? selected.name : placeholder)}
        value={open ? search : (selected ? selected.name : '')}
        onFocus={focus}
        onChange={e => setSearch(e.target.value)}
        onKeyDown={keys}
      />

      {/* Карандашик — переименовать выбранный элемент, не уходя из формы.
          Рисуем svg, а не знак ✎: шрифтовой символ система подменяет цветным
          глифом из эмодзи-шрифта, и заданный серый цвет к нему не применяется */}
      {editable && selected && (
        <button type="button" title={`Изменить «${selected.name}»`}
          onMouseDown={e => { e.preventDefault(); setOpen(false); setCard('edit') }}
          className={`absolute right-7 ${label ? 'top-[2.15rem]' : 'top-1/2 -translate-y-1/2'} text-gray-400 hover:text-gray-600 transition-colors`}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
          </svg>
        </button>
      )}

      {allowClear && value && !disabled && (
        <button type="button" onClick={() => { onChange(null); setSearch('') }}
          className={`absolute right-2 ${label ? 'top-[2.15rem]' : 'top-1/2 -translate-y-1/2'} text-gray-300 hover:text-gray-500 text-xs`}>✕</button>
      )}

      {open && createPortal(
        <div ref={dropRef}
          className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-xl max-h-72 overflow-y-auto"
          style={{ top: pos.top, left: pos.left, width: pos.width }}>

          {emptyLabel && !search && (
            <div className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 cursor-pointer border-b border-gray-100"
              onMouseDown={() => { onChange(null); setOpen(false); setSearch('') }}>
              {emptyLabel}
            </div>
          )}

          {recent.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 bg-gray-50">Недавние</div>
              {recent.map(i => row({ ...i, depth: 0 }, `r_${i.id}`))}
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 bg-gray-50 border-t border-gray-100">
                Весь справочник
              </div>
            </>
          )}

          {loading
            ? <div className="px-3 py-2 text-xs text-gray-400">Загружаю справочник…</div>
            : filtered.length === 0
              ? <div className="px-3 py-2 text-xs text-gray-400">Ничего не найдено</div>
              : filtered.map(i => row(i, i.id))}

          {/* Нужного элемента нет — заводим здесь же. Уходить за этим в
              «Справочники», теряя набранное, неправильно */}
          {editable && (
            <div className="px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 cursor-pointer border-t border-gray-100 flex items-center gap-1.5 sticky bottom-0 bg-white"
              onMouseDown={e => { e.preventDefault(); setOpen(false); setCard('create') }}>
              <span className="text-blue-500">+</span>
              Создать{search ? ` «${search}»` : `: ${INFO_LABELS[infoType] || infoType}`}
            </div>
          )}
        </div>,
        document.body,
      )}

      {card && (
        <InfoItemCard
          infoType={infoType}
          item={card === 'edit' ? selected : null}
          items={list}
          initialName={card === 'create' ? search : ''}
          onSaved={saved}
          onClose={() => setCard(null)}
        />
      )}
    </div>
  )
}
