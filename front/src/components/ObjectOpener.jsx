import { Suspense, lazy, useEffect, useState } from 'react'
import OperationForm from './OperationForm'
import InfoItemCard from './InfoItemCard'
import { Spinner } from './Busy'
import { getOperations, getBalanceItems } from '../api/operations'
import { getDocument } from '../api/documents'
import { getInfo } from '../api/info'

/**
 * Открыть объект поверх текущей страницы.
 *
 * Журнал изменений и список недавних раньше уводили на страницу объекта и уже
 * там открывали окно. Это неверно: человек смотрел журнал, а оказывался в
 * списке операций за какой-то период — и возвращаться приходилось назад по
 * истории браузера. Объект нужно открыть там, где стоишь.
 *
 * Поэтому опознаватель живёт в шапке приложения и слушает событие: звать его
 * может кто угодно, не таща за собой ни маршрутов, ни пропсов.
 *
 * Форма документа подгружается лениво нарочно: она лежит в DocumentsPage,
 * который сам тянет Layout, — статический импорт замкнул бы круг.
 */

const DocumentForm = lazy(() =>
  import('../pages/DocumentsPage').then(m => ({ default: m.DocumentForm }))
)

/** Позвать открытие откуда угодно */
export const openObject = (entity, id) =>
  window.dispatchEvent(new CustomEvent('findir:open-object', { detail: { entity, id } }))

export default function ObjectOpener() {
  const [state, setState] = useState(null)   // { entity, id, loading, data, error }

  // Справочники для формы документа — те же, что грузит его страница
  const [balanceItems, setBalanceItems] = useState([])
  const [infoCache, setInfoCache]       = useState({})

  const loadInfo = (type) =>
    getInfo({ type }).then(r => setInfoCache(c => ({ ...c, [type]: r.data.data })))

  useEffect(() => {
    const onOpen = (e) => {
      const { entity, id } = e.detail || {}
      if (!entity || !id) return

      setState({ entity, id, loading: true, data: null, error: '' })
      load(entity, id)
        .then(data => setState(s => s && s.id === id
          ? { ...s, loading: false, data, error: data ? '' : 'Объект не найден — возможно, его удалили' }
          : s))
        .catch(() => setState(s => s && s.id === id
          ? { ...s, loading: false, error: 'Не удалось открыть объект' }
          : s))
    }

    window.addEventListener('findir:open-object', onOpen)
    return () => window.removeEventListener('findir:open-object', onOpen)
  }, [])

  // Счета нужны форме документа; читаем один раз, когда она впервые понадобится
  useEffect(() => {
    if (state?.entity === 'document' && balanceItems.length === 0) {
      getBalanceItems().then(r => setBalanceItems(r.data.data || [])).catch(() => {})
    }
  }, [state?.entity])

  const close = () => setState(null)

  if (!state) return null

  if (state.loading) {
    return (
      <div className="fixed inset-0 z-[95] bg-black/30 flex items-center justify-center">
        <div className="bg-white rounded-xl px-5 py-4 shadow-xl flex items-center gap-3 text-sm text-gray-600">
          <Spinner /> Открываю…
        </div>
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="fixed inset-0 z-[95] bg-black/30 flex items-center justify-center p-4" onClick={close}>
        <div className="bg-white rounded-xl px-5 py-4 shadow-xl max-w-sm" onClick={e => e.stopPropagation()}>
          <p className="text-sm text-gray-700">{state.error}</p>
          <button onClick={close} className="mt-3 text-sm text-blue-700 hover:underline">Закрыть</button>
        </div>
      </div>
    )
  }

  if (state.entity === 'operation') {
    return (
      <OperationForm
        operation={state.data}
        onSuccess={close}
        onCancel={close}
      />
    )
  }

  if (state.entity === 'info') {
    const { item, items } = state.data

    return (
      <InfoItemCard
        infoType={item.type}
        item={item}
        items={items}
        onSaved={close}
        onClose={close}
      />
    )
  }

  return (
    <Suspense fallback={null}>
      <DocumentForm
        docType={state.data.type}
        doc={state.data}
        balanceItems={balanceItems}
        infoCache={infoCache}
        loadInfo={loadInfo}
        onSave={close}
        onCancel={close}
        onChanged={() => { /* списки страницы обновятся при возврате на неё */ }}
      />
    </Suspense>
  )
}

/** Читаем объект целиком: в журнале лежит только его номер */
async function load(entity, id) {
  if (entity === 'operation') {
    const r = await getOperations({ ids: String(id) })
    return (r.data.data || [])[0] || null
  }

  if (entity === 'document') {
    const r = await getDocument(id)
    return r.data.data || null
  }

  // Карточке справочника нужен ещё и список того же вида — для выбора родителя
  const r     = await getInfo({})
  const all   = r.data.data || []
  const item  = all.find(i => Number(i.id) === Number(id))

  return item ? { item, items: all.filter(i => i.type === item.type) } : null
}
