import { useEffect, useState } from 'react'
import { getInfo, createInfo, updateInfo } from '../api/info'
import { INFO_LABELS } from '../utils/infoLabels'

/**
 * Карточка элемента справочника поверх формы.
 *
 * Заводить статью расхода или контрагента приходится ровно в тот момент, когда
 * заполняешь документ, — и уходить за этим в «Справочники», теряя набранное,
 * неправильно. Карточка живёт отдельным окном по центру: раскрывать её внутри
 * выпадающего списка значит уезжать за край экрана в нижних строках таблицы.
 *
 * Вынесена отдельно, потому что нужна не одной форме: сейчас ею пользуются
 * документы. В OperationForm живёт своя, более старая копия того же экрана —
 * её стоит перевести сюда, пока они не разошлись.
 */

const fc = 'w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const fl = 'block text-[11px] text-gray-500 mb-0.5'

const EMPTY = {
  name: '', code: '', parent_id: '', inn: '', description: '',
  sort_order: 0, is_active: true, default_expense_id: '',
}

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
  let r = []
  nodes.forEach(n => {
    r.push({ ...n, depth })
    if (n.children?.length) r = r.concat(flatten(n.children, depth + 1))
  })
  return r
}

/**
 * @param infoType  тип справочника ('expenses', 'partner', ...)
 * @param item      правим этот элемент; null — заводим новый
 * @param items     весь справочник этого типа — нужен для выбора родителя
 * @param initialName подставить в имя нового элемента (то, что успели набрать в поиске)
 * @param onSaved   (сохранённый элемент, id заменённого или null)
 * @param onClose   закрыть без сохранения
 */
export default function InfoItemCard({ infoType, item = null, items = [], initialName = '', onSaved, onClose }) {
  const isEdit = !!item

  const [fields, setFields] = useState(() => item ? {
    name:               item.name || '',
    code:               item.code || '',
    parent_id:          item.parent_id || '',
    inn:                item.inn || '',
    description:        item.description || '',
    sort_order:         item.sort_order ?? 0,
    is_active:          item.is_active ?? true,
    default_expense_id: item.default_expense_id || '',
  } : { ...EMPTY, name: initialName })

  const [expenseOpts, setExpenseOpts] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  // Статья расхода по умолчанию — реквизит только у статей ДДС
  useEffect(() => {
    if (infoType !== 'flow') return
    getInfo({ type: 'expenses' }).then(r => setExpenseOpts(r.data.data || [])).catch(() => {})
  }, [infoType])

  const flatItems = flatten(buildTree(items || []))

  const payload = () => ({
    name:               fields.name.trim(),
    type:               infoType,
    code:               fields.code?.trim() || null,
    description:        fields.description?.trim() || null,
    inn:                fields.inn?.trim() || null,
    parent_id:          fields.parent_id || null,
    sort_order:         parseInt(fields.sort_order) || 0,
    default_expense_id: fields.default_expense_id || null,
  })

  const submit = async () => {
    if (!fields.name.trim() || !infoType) return
    setSaving(true); setError('')
    try {
      const res = isEdit
        ? await updateInfo(item.id, { ...payload(), is_active: !!fields.is_active })
        : await createInfo(payload())
      onSaved(res.data.data, isEdit ? item.id : null)
    } catch (err) {
      setError(err?.response?.data?.message || (isEdit ? 'Не удалось сохранить' : 'Не удалось создать элемент'))
    } finally {
      setSaving(false)
    }
  }

  const label = INFO_LABELS[infoType] || infoType

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[88vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>

        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white">
          <h4 className="text-sm font-semibold text-gray-800">
            {isEdit ? `${label}: ${item.name}` : `Новый элемент: ${label}`}
          </h4>
          <button type="button" onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">&times;</button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <span className={fl}>Наименование</span>
            <input type="text" className={fc} placeholder="Название элемента справочника"
              value={fields.name} autoFocus
              onChange={e => setFields(f => ({ ...f, name: e.target.value }))}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); submit() }
                if (e.key === 'Escape') onClose()
              }} />
          </div>

          <div>
            <span className={fl}>Родительская группа</span>
            <select className={`${fc} text-gray-700`} value={fields.parent_id}
              onChange={e => setFields(f => ({ ...f, parent_id: e.target.value }))}>
              <option value="">— Без родителя (верхний уровень)</option>
              {/* Отступ неразрывными пробелами: обычные в <option> схлопываются,
                  и вложенность справочника перестала бы читаться */}
              {flatItems.filter(o => o.id != item?.id).map(o => (
                <option key={o.id} value={o.id}>
                  {' '.repeat(o.depth * 2)}{o.depth > 0 ? '└ ' : ''}{o.name}
                </option>
              ))}
            </select>
          </div>

          {infoType === 'partner' && (
            <div>
              <span className={fl}>ИНН</span>
              <input type="text" className={fc} placeholder="10 или 12 цифр" maxLength={12}
                value={fields.inn}
                onChange={e => setFields(f => ({ ...f, inn: e.target.value.replace(/\D/g, '') }))} />
            </div>
          )}

          {infoType === 'flow' && (
            <div>
              <span className={fl}>Статья расхода по умолчанию</span>
              <select className={`${fc} text-gray-700`} value={fields.default_expense_id}
                onChange={e => setFields(f => ({ ...f, default_expense_id: e.target.value }))}>
                <option value="">— не задана</option>
                {expenseOpts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <span className="block text-[10px] text-gray-400 mt-0.5">
                Подставится в операцию при выборе этой статьи ДДС
              </span>
            </div>
          )}

          <div>
            <span className={fl}>Описание</span>
            <textarea rows={2} className={fc} placeholder="Необязательно"
              value={fields.description}
              onChange={e => setFields(f => ({ ...f, description: e.target.value }))} />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-32">
              <span className={fl}>Код</span>
              <input type="text" className={fc} placeholder="—"
                value={fields.code} onChange={e => setFields(f => ({ ...f, code: e.target.value }))} />
            </div>
            <div className="w-24">
              <span className={fl}>Порядок</span>
              <input type="number" step="1" className={fc}
                value={fields.sort_order}
                onChange={e => setFields(f => ({ ...f, sort_order: e.target.value }))} />
            </div>
            {isEdit && (
              <label className="flex items-center gap-1.5 text-xs text-gray-600 mt-4">
                <input type="checkbox" className="rounded" checked={!!fields.is_active}
                  onChange={e => setFields(f => ({ ...f, is_active: e.target.checked }))} />
                Активен
              </label>
            )}
          </div>

          {error && <div className="text-xs text-red-600">{error}</div>}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={submit} disabled={!fields.name.trim() || saving}
              className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? '...' : isEdit ? 'Сохранить' : 'Создать'}
            </button>
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-gray-500 hover:text-gray-700 text-sm border border-gray-200 rounded-lg">
              Отмена
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
