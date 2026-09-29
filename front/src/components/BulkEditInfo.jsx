import { useEffect, useState } from 'react'
import { previewInfoBulk, applyInfoBulk } from '../api/info'
import { EXPENSE_KINDS, FLOW_KINDS, INFO_LABELS } from '../utils/infoLabels'

/**
 * Массовая правка элементов одного справочника.
 *
 * Правим только то, что не меняет природу элемента: родителя и вид (расхода
 * или деятельности). Имя у каждого своё, а справочник менять массово нельзя
 * вовсе — на элементы ссылаются операции и документы.
 *
 * Сделано по образцу массовой правки операций: поле меняется, только если
 * отмечено галочкой, и перед применением показываем предпросмотр.
 */

const SKIP_LABELS = {
  self:     'родитель — сам себе',
  cycle:    'родитель внутри собственной ветки',
  nochange: 'уже с такими значениями',
}

const ic = 'w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

/** Строка поля: галочка «менять» и само поле. На уровне модуля — иначе
    React пересоздавал бы поле на каждом нажатии и ввод терял бы фокус */
const Row = ({ label, on, onToggle, children }) => (
  <div className="flex items-center gap-3 py-1.5">
    <label className="flex items-center gap-2 w-44 flex-shrink-0 cursor-pointer">
      <input type="checkbox" checked={on} onChange={onToggle}
        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
      <span className={`text-sm ${on ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>{label}</span>
    </label>
    <div className="flex-1 min-w-0">
      {on ? children : <div className="text-xs text-gray-300">не меняется</div>}
    </div>
  </div>
)

export default function BulkEditInfo({ ids, type, items, onClose, onApplied }) {
  // Список фиксируем на открытии: страница после применения снимет выделение
  const [itemIds] = useState(() => [...ids])
  const [enabled, setEnabled] = useState(new Set())
  const [values, setValues]   = useState({})
  const [preview, setPreview] = useState(null)
  const [result, setResult]   = useState(null)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState('')

  const toggle = (key) => setEnabled(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const kinds = type === 'expenses' ? EXPENSE_KINDS : type === 'flow' ? FLOW_KINDS : null
  const kindField = type === 'expenses' ? 'expense_kind' : type === 'flow' ? 'flow_kind' : null
  const kindLabel = type === 'expenses' ? 'Вид расхода' : 'Вид деятельности'

  /**
   * Куда можно перенести: элементы того же справочника, кроме выбранных и их
   * потомков. Перенос ветки под собственного потомка сервер тоже не пропустит,
   * но предлагать его в списке — значит звать на ошибку.
   */
  const parentOptions = () => {
    const picked = new Set(itemIds.map(String))
    const byParent = {}
    items.forEach(i => { (byParent[i.parent_id ?? 0] ||= []).push(i) })

    const out = []
    const walk = (pid, depth, insidePicked) => {
      ;(byParent[pid] || [])
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name))
        .forEach(i => {
          const mine = insidePicked || picked.has(String(i.id))
          if (!mine) out.push({ ...i, depth })
          walk(i.id, mine ? depth : depth + 1, mine)
        })
    }
    walk(0, 0, false)

    return out
  }

  const buildSet = () => {
    const set = {}
    if (enabled.has('parent_id')) {
      const v = values.parent_id
      set.parent_id = v === '' || v === undefined ? null : Number(v)
    }
    if (kindField && enabled.has(kindField)) {
      set[kindField] = values[kindField] || kinds[0].id
    }
    return set
  }

  const set = buildSet()
  const hasChanges = Object.keys(set).length > 0

  /**
   * Предпросмотр считается сам, с небольшой задержкой.
   *
   * Отдельной кнопки «посмотреть» здесь нет намеренно: по её названию не
   * понять, что она делает, а ответ на вопрос «сколько изменится» нужен
   * всегда. Так же устроена массовая правка операций.
   */
  useEffect(() => {
    if (!hasChanges || result) { setPreview(null); return }

    const t = setTimeout(() => {
      previewInfoBulk(itemIds, set)
        .then(res => { setPreview(res.data); setError('') })
        .catch(err => { setPreview(null); setError(err.response?.data?.message || '') })
    }, 350)

    return () => clearTimeout(t)
  }, [JSON.stringify(set), result])

  const handleApply = async () => {
    setBusy(true); setError('')
    try {
      const res = await applyInfoBulk(itemIds, set)
      setResult(res.data)
      onApplied?.()
    } catch (err) {
      setError(err.response?.data?.message || 'Не получилось изменить')
    } finally {
      setBusy(false)
    }
  }

  const skipList = Object.entries((result || preview)?.skipped || {})

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-100 flex justify-between items-center">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Массовое изменение</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {INFO_LABELS[type] || type} · выбрано: {itemIds.length}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {result ? (
          <div className="p-8 text-center">
            <div className="text-3xl mb-3">✓</div>
            <p className="text-gray-800 font-medium">Изменено записей: {result.updated}</p>
            {skipList.length > 0 && (
              <p className="text-sm text-gray-400 mt-2">
                Пропущено: {skipList.map(([k, n]) => `${n} — ${SKIP_LABELS[k] || k}`).join(', ')}
              </p>
            )}
            <p className="text-xs text-gray-400 mt-3">
              Правка записана в историю каждой записи — там же её можно вернуть.
            </p>
            <button onClick={onClose}
              className="mt-6 px-5 py-2.5 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
              Готово
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-5">
              <Row label="Родитель" on={enabled.has('parent_id')} onToggle={() => toggle('parent_id')}>
                <select className={ic} value={values.parent_id ?? ''}
                  onChange={e => setValues(v => ({ ...v, parent_id: e.target.value }))}>
                  <option value="">— в корень, без родителя —</option>
                  {parentOptions().map(i => (
                    <option key={i.id} value={i.id}>
                      {' '.repeat(i.depth * 2)}{i.depth > 0 ? '└ ' : ''}{i.name}
                    </option>
                  ))}
                </select>
              </Row>

              {kindField && (
                <Row label={kindLabel} on={enabled.has(kindField)} onToggle={() => toggle(kindField)}>
                  <select className={ic} value={values[kindField] ?? kinds[0].id}
                    onChange={e => setValues(v => ({ ...v, [kindField]: e.target.value }))}>
                    {kinds.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
                  </select>
                </Row>
              )}

              {!kindField && (
                <p className="text-xs text-gray-400 mt-3">
                  У этого справочника из массовых правок доступен только родитель.
                  Вид есть у статей расхода и статей ДДС.
                </p>
              )}

              {preview && (
                <div className="mt-5 pt-4 border-t border-gray-100 text-sm">
                  <p className="text-gray-800">
                    Изменится записей: <span className="font-semibold">{preview.will_update}</span> из {preview.total}
                  </p>
                  {preview.description && (
                    <p className="text-xs text-gray-500 mt-1">{preview.description}</p>
                  )}
                  {skipList.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      Пропустим: {skipList.map(([k, n]) => `${n} — ${SKIP_LABELS[k] || k}`).join(', ')}
                    </p>
                  )}
                </div>
              )}

              {error && <p className="text-sm text-red-600 mt-4">{error}</p>}
            </div>

            <div className="p-5 border-t border-gray-100 flex gap-3">
              <button onClick={onClose}
                className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
                Отмена
              </button>
              {/* Число прямо на кнопке: оно и есть ответ на вопрос «что будет» */}
              <button onClick={handleApply}
                disabled={busy || !hasChanges || !preview || preview.will_update === 0}
                className="flex-1 px-4 py-2.5 bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50 text-sm font-medium">
                {busy ? 'Применяю...'
                  : !hasChanges ? 'Отметьте, что менять'
                  : preview?.will_update === 0 ? 'Нечего менять'
                  : `Изменить (${preview?.will_update ?? 0})`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
