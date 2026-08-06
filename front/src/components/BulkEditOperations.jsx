import { useEffect, useState } from 'react'
import { getInfo } from '../api/info'
import { previewBulk, applyBulkEdit, revertBulkEdit } from '../api/bulkOperations'

// Реквизиты, доступные для массовой правки. Новый — одна строка здесь
// и одна в BulkOperationEditor::FIELDS на бэкенде.
const FIELDS = [
  { key: 'in_bi_id',   label: 'Счёт дебета',  kind: 'account' },
  { key: 'out_bi_id',  label: 'Счёт кредита', kind: 'account' },
  { key: 'project_id', label: 'Проект',       kind: 'project' },
  { key: 'content',    label: 'Содержание',   kind: 'text' },
  { key: 'note',       label: 'Примечание',   kind: 'text' },
]

const ANALYTICS = [
  { key: 'partner',    label: 'Контрагент' },
  { key: 'product',    label: 'Товар/Услуга' },
  { key: 'cash',       label: 'Касса/Счёт' },
  { key: 'employee',   label: 'Сотрудник' },
  { key: 'revenue',    label: 'Статья дохода' },
  { key: 'expenses',   label: 'Статья расхода' },
  { key: 'department', label: 'Отдел' },
  { key: 'flow',       label: 'Статья ДДС' },
]

const SKIP_LABELS = {
  locked:       'в закрытом периоде',
  document:     'созданы из документов',
  same_account: 'дебет совпал бы с кредитом',
  no_slot:      'у счетов нет такой аналитики',
  nochange:     'уже с такими значениями',
}

// Плоский список справочника с отступами по иерархии
const flatInfo = (items) => {
  const byParent = {}
  items.forEach(i => { (byParent[i.parent_id ?? 0] ||= []).push(i) })

  const out = []
  const walk = (pid, depth) => {
    ;(byParent[pid] || [])
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name))
      .forEach(i => { out.push({ ...i, depth }); walk(i.id, depth + 1) })
  }
  walk(0, 0)

  // Если у части записей родитель вне выборки — не теряем их
  return out.length === items.length ? out : items.map(i => ({ ...i, depth: 0 }))
}

/**
 * Массовая правка выбранных операций.
 *
 * Поле меняется, только если явно отмечено галочкой: пустое значение у
 * отмеченного поля означает «очистить», а не «не трогать» — иначе очистить
 * аналитику было бы нечем.
 *
 * Перед применением показываем предпросмотр: сколько операций реально
 * изменится и что будет пропущено. Пропуски (документы, закрытый период)
 * нормальны, и о них честнее сказать заранее.
 */
export default function BulkEditOperations({ ids, balanceItems, projects, onClose, onApplied }) {
  // Список фиксируем на открытии: после применения страница снимает выделение,
  // а окно с результатом ещё живо и должно показывать те же цифры
  const [opIds] = useState(() => [...ids])
  const [enabled, setEnabled] = useState(new Set())
  const [values, setValues]   = useState({})
  const [side, setSide]       = useState('any')
  const [dicts, setDicts]     = useState({})     // тип → элементы справочника
  const [preview, setPreview] = useState(null)
  const [busy, setBusy]       = useState(false)
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [reverted, setReverted] = useState(false)

  const anyAnalytics = ANALYTICS.some(a => enabled.has('a:' + a.key))

  const toggle = (key) => setEnabled(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  // Справочник грузим, когда аналитику включили
  useEffect(() => {
    ANALYTICS.forEach(a => {
      if (enabled.has('a:' + a.key) && !dicts[a.key]) {
        getInfo({ type: a.key })
          .then(res => setDicts(d => ({ ...d, [a.key]: res.data.data || [] })))
          .catch(() => setDicts(d => ({ ...d, [a.key]: [] })))
      }
    })
  }, [enabled])

  const buildSet = () => {
    const set = {}
    FIELDS.forEach(f => {
      if (!enabled.has(f.key)) return
      const v = values[f.key]
      set[f.key] = v === '' || v === undefined ? null : v
    })
    const analytics = {}
    ANALYTICS.forEach(a => {
      if (!enabled.has('a:' + a.key)) return
      const v = values['a:' + a.key]
      analytics[a.key] = v === '' || v === undefined ? null : Number(v)
    })
    if (Object.keys(analytics).length) set.analytics = analytics
    return set
  }

  const hasChanges = enabled.size > 0

  // Предпросмотр — с небольшой задержкой, чтобы не дёргать сервер на каждый символ
  useEffect(() => {
    if (!hasChanges || result) { setPreview(null); return }
    const t = setTimeout(() => {
      previewBulk(opIds, buildSet(), side)
        .then(res => { setPreview(res.data); setError('') })
        .catch(err => { setPreview(null); setError(err.response?.data?.message || '') })
    }, 350)
    return () => clearTimeout(t)
  }, [enabled, values, side, result])

  const handleApply = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await applyBulkEdit(opIds, buildSet(), side)
      setResult(res.data)
      if (onApplied) onApplied()
    } catch (err) {
      setError(err.response?.data?.message || 'Не удалось применить правку')
    } finally {
      setBusy(false)
    }
  }

  const handleRevert = async () => {
    if (!result?.log_id) return
    setBusy(true)
    try {
      await revertBulkEdit(result.log_id)
      setReverted(true)
      if (onApplied) onApplied()
    } catch (err) {
      setError(err.response?.data?.message || 'Не удалось откатить')
    } finally {
      setBusy(false)
    }
  }

  const ic = 'w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  const Row = ({ fieldKey, label, children }) => (
    <div className="flex items-center gap-3 py-1.5">
      <label className="flex items-center gap-2 w-44 flex-shrink-0 cursor-pointer">
        <input type="checkbox" checked={enabled.has(fieldKey)} onChange={() => toggle(fieldKey)}
          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
        <span className={`text-sm ${enabled.has(fieldKey) ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>
          {label}
        </span>
      </label>
      <div className="flex-1 min-w-0">
        {enabled.has(fieldKey) ? children : <div className="text-xs text-gray-300">не меняется</div>}
      </div>
    </div>
  )

  const skipList = Object.entries((result || preview)?.skipped || {})

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-100 flex justify-between items-center">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Массовое изменение</h3>
            <p className="text-xs text-gray-400 mt-0.5">Выбрано операций: {opIds.length}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {result ? (
          <div className="p-8 text-center">
            <div className="text-3xl mb-3">{reverted ? '↩' : '✓'}</div>
            <p className="text-gray-800 font-medium">
              {reverted ? 'Правка откачена' : `Изменено операций: ${result.updated}`}
            </p>
            {!reverted && skipList.length > 0 && (
              <p className="text-sm text-gray-400 mt-2">
                Пропущено: {skipList.map(([k, n]) => `${n} ${SKIP_LABELS[k] || k}`).join(', ')}
              </p>
            )}
            {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
            <div className="flex gap-3 justify-center mt-6">
              {!reverted && result.log_id && (
                <button onClick={handleRevert} disabled={busy}
                  className="px-4 py-2.5 border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50">
                  ↩ Откатить
                </button>
              )}
              <button onClick={onClose}
                className="px-5 py-2.5 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
                Готово
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Реквизиты</div>
              {FIELDS.map(f => (
                <Row key={f.key} fieldKey={f.key} label={f.label}>
                  {f.kind === 'account' && (
                    <select className={ic} value={values[f.key] ?? ''}
                      onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value ? Number(e.target.value) : '' }))}>
                      <option value="">— выберите счёт —</option>
                      {balanceItems.map(b => (
                        <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                      ))}
                    </select>
                  )}
                  {f.kind === 'project' && (
                    <select className={ic} value={values[f.key] ?? ''}
                      onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value ? Number(e.target.value) : '' }))}>
                      <option value="">— выберите проект —</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  {f.kind === 'text' && (
                    <input type="text" className={ic} value={values[f.key] ?? ''}
                      placeholder="пусто — очистить"
                      onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} />
                  )}
                </Row>
              ))}

              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-5 mb-2">Аналитика</div>
              {ANALYTICS.map(a => (
                <Row key={a.key} fieldKey={'a:' + a.key} label={a.label}>
                  <select className={ic} value={values['a:' + a.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, ['a:' + a.key]: e.target.value }))}>
                    <option value="">— очистить —</option>
                    {flatInfo(dicts[a.key] || []).map(i => (
                      <option key={i.id} value={i.id}>
                        {' '.repeat(i.depth * 2)}{i.depth > 0 ? '└ ' : ''}{i.name}
                      </option>
                    ))}
                  </select>
                </Row>
              ))}

              {anyAnalytics && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <div className="text-xs text-gray-500 font-medium mb-2">
                    Куда писать аналитику
                    <span className="ml-1.5 font-normal text-gray-400">
                      — значение попадёт в тот слот счёта, который объявлен под этот тип
                    </span>
                  </div>
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium w-fit">
                    {[
                      { key: 'any',    label: 'Обе стороны' },
                      { key: 'debit',  label: 'Только дебет' },
                      { key: 'credit', label: 'Только кредит' },
                    ].map(s => (
                      <button key={s.key} type="button" onClick={() => setSide(s.key)}
                        className={`px-3 py-1.5 transition-colors ${
                          side === s.key ? 'bg-blue-900 text-white' : 'text-gray-500 hover:bg-gray-50'
                        }`}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-gray-100">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-lg text-sm mb-3">
                  {error}
                </div>
              )}

              {preview && (
                <div className="text-sm text-gray-600 mb-3">
                  Будет изменено: <span className="font-semibold text-gray-800">{preview.will_update}</span> из {preview.total}
                  {skipList.length > 0 && (
                    <span className="text-gray-400">
                      {' '}— пропустим {skipList.map(([k, n]) => `${n} ${SKIP_LABELS[k] || k}`).join(', ')}
                    </span>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <button type="button" onClick={onClose}
                  className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
                  Отмена
                </button>
                <button type="button" onClick={handleApply}
                  disabled={busy || !hasChanges || !preview || preview.will_update === 0}
                  className="flex-1 px-4 py-2.5 bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50 text-sm font-medium">
                  {busy ? 'Применяю...'
                    : !hasChanges ? 'Отметьте, что менять'
                    : preview?.will_update === 0 ? 'Нечего менять'
                    : `Изменить (${preview?.will_update ?? 0})`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
