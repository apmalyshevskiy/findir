import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import { SkeletonRows } from '../components/Busy'
import { getBalanceItems } from '../api/operations'
import { INFO_LABELS } from '../utils/infoLabels'
import {
  getDocumentTypes, createDocumentType, updateDocumentType, deleteDocumentType,
} from '../api/documentTypes'

/**
 * Виды документов.
 *
 * Вид отвечает на один вопрос: во что превращается документ при проведении.
 * Счёт шапки идёт в свою сторону, счета строк — в противоположную, из каждой
 * строки получается операция. Поэтому «начисление ЗП» и «авансовый отчёт» —
 * это не код, а две строки справочника с одними и теми же счетами и разной
 * стороной шапки.
 */

const EMPTY = {
  name: '', head_bi_id: '', head_side: 'credit', item_bi_id: '',
  show_quantity: false, show_price: false, show_vat: false,
  line_head_fields: [],
  is_active: true, sort_order: 0,
}

const ic  = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const lbl = 'block text-xs font-medium text-gray-500 mb-1'

/** Наглядная подпись проводки: понятнее любого описания сторон */
function PostingHint({ type, accounts }) {
  const head = accounts.find(b => b.id == type.head_bi_id)
  const item = accounts.find(b => b.id == type.item_bi_id)
  const headLabel = head ? `${head.code} ${head.name}` : 'счёт шапки'
  const itemLabel = item ? `${item.code} ${item.name}` : 'счёт строки'
  const debit  = type.head_side === 'debit' ? headLabel : itemLabel
  const credit = type.head_side === 'debit' ? itemLabel : headLabel

  return (
    <div className="text-[11px] leading-relaxed">
      <div><span className="text-green-700 font-medium">Дт</span> <span className="text-gray-600">{debit}</span></div>
      <div><span className="text-red-500 font-medium">Кт</span> <span className="text-gray-600">{credit}</span></div>
    </div>
  )
}

export default function DocumentTypesPage() {
  const [types, setTypes]         = useState(null)
  const [accounts, setAccounts]   = useState([])
  const [form, setForm]           = useState(null)   // { ...поля, id? }
  const [error, setError]         = useState('')
  const [saving, setSaving]       = useState(false)

  const load = () => getDocumentTypes().then(r => setTypes(r.data.data || []))

  useEffect(() => {
    load()
    getBalanceItems().then(r => setAccounts(r.data.data || [])).catch(() => {})
  }, [])

  const startCreate = () => { setError(''); setForm({ ...EMPTY }) }
  const startEdit   = (t) => {
    setError('')
    setForm({
      id: t.id, name: t.name,
      head_bi_id: t.head_bi_id ?? '', head_side: t.head_side, item_bi_id: t.item_bi_id ?? '',
      show_quantity: t.show_quantity, show_price: t.show_price, show_vat: t.show_vat,
      line_head_fields: t.line_head_fields || [],
      is_active: t.is_active, sort_order: t.sort_order,
      is_system: t.is_system,
    })
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Название обязательно'); return }
    setSaving(true); setError('')
    try {
      const payload = {
        ...form,
        head_bi_id: form.head_bi_id || null,
        item_bi_id: form.item_bi_id || null,
      }
      form.id ? await updateDocumentType(form.id, payload) : await createDocumentType(payload)
      setForm(null)
      await load()
    } catch (e) {
      setError(e.response?.data?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  const remove = async (t) => {
    if (!confirm(`Удалить вид «${t.name}»?`)) return
    try {
      await deleteDocumentType(t.id)
      await load()
    } catch (e) {
      alert(e.response?.data?.message || 'Не удалось удалить')
    }
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">Виды документов</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Из чего состоит документ и какой проводкой он ложится в учёт
          </p>
        </div>
        <button onClick={startCreate}
          className="bg-blue-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800">
          + Добавить вид
        </button>
      </div>

      {form && (
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 mb-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className={lbl}>Название</label>
              <input className={ic} value={form.name} autoFocus
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Начисление ЗП" />
            </div>
            <div>
              <label className={lbl}>Счёт шапки</label>
              <select className={ic} value={form.head_bi_id} disabled={form.is_system}
                onChange={e => setForm(f => ({ ...f, head_bi_id: e.target.value }))}>
                <option value="">— не выбран</option>
                {accounts.map(b => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Сторона шапки</label>
              <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 text-sm">
                {[
                  { v: 'debit',  t: 'Дебет'  },
                  { v: 'credit', t: 'Кредит' },
                ].map(o => (
                  <button key={o.v} type="button" disabled={form.is_system}
                    onClick={() => setForm(f => ({ ...f, head_side: o.v }))}
                    className={`flex-1 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50 ${
                      form.head_side === o.v ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500'
                    }`}>
                    {o.t}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Строки идут в противоположную сторону</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className={lbl}>Счёт строк по умолчанию</label>
              <select className={ic} value={form.item_bi_id} disabled={form.is_system}
                onChange={e => setForm(f => ({ ...f, item_bi_id: e.target.value }))}>
                <option value="">— не выбран</option>
                {accounts.map(b => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">В самом документе его можно сменить</p>
            </div>
            <div>
              <label className={lbl}>Колонки в строках</label>
              <div className="flex flex-wrap gap-3 pt-1.5">
                {[
                  { k: 'show_quantity', t: 'Количество' },
                  { k: 'show_price',    t: 'Цена' },
                  { k: 'show_vat',      t: 'НДС' },
                ].map(o => (
                  <label key={o.k} className="flex items-center gap-1.5 text-sm text-gray-600">
                    <input type="checkbox" className="rounded" checked={!!form[o.k]} disabled={form.is_system}
                      onChange={e => setForm(f => ({ ...f, [o.k]: e.target.checked }))} />
                    {o.t}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Сумма есть всегда</p>
            </div>
            <div>
              <label className={lbl}>Порядок и видимость</label>
              <div className="flex items-center gap-3">
                <input type="number" className={`${ic} w-24`} value={form.sort_order}
                  onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
                <label className="flex items-center gap-1.5 text-sm text-gray-600">
                  <input type="checkbox" className="rounded" checked={!!form.is_active}
                    onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                  Активен
                </label>
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Выключенный не появляется вкладкой</p>
            </div>
          </div>

          {/* Что из корреспондирующей стороны задаётся в каждой строке.
              Подписи — по аналитике счёта шапки: у А100 это «Касса/Счёт» и
              «Статья ДДС», а не безликие «слот 1» и «слот 2» */}
          {!form.is_system && (
            <div>
              <label className={lbl}>Задаётся в строках</label>
              <div className="flex flex-wrap gap-3 pt-0.5">
                {[
                  { k: 'bi', t: 'Счёт корреспонденции' },
                  ...[1, 2, 3].map(n => {
                    const head = accounts.find(b => b.id == form.head_bi_id)
                    const type = head?.[`info_${n}_type`]
                    return type ? { k: `info_${n}`, t: INFO_LABELS[type] || type } : null
                  }).filter(Boolean),
                ].map(o => (
                  <label key={o.k} className="flex items-center gap-1.5 text-sm text-gray-600">
                    <input type="checkbox" className="rounded"
                      checked={form.line_head_fields.includes(o.k)}
                      onChange={e => setForm(f => ({
                        ...f,
                        line_head_fields: e.target.checked
                          ? [...f.line_head_fields, o.k]
                          : f.line_head_fields.filter(x => x !== o.k),
                      }))} />
                    {o.t}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Отмеченное станет колонкой в строке. Что не заполнено в строке — берётся из шапки
              </p>
            </div>
          )}

          {form.is_system && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Системный вид: счета и проводка заданы его собственной логикой в коде,
              меняется только название, порядок и видимость.
            </div>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex gap-2">
            <button onClick={save} disabled={saving}
              className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            <button onClick={() => setForm(null)}
              className="px-4 py-2 border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50">
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {types === null ? (
          <div className="p-4"><SkeletonRows rows={4} /></div>
        ) : types.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">Видов пока нет</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-2">Вид</th>
                <th className="text-left px-4 py-2">Проводка</th>
                <th className="text-left px-4 py-2">Колонки строк</th>
                <th className="text-right px-4 py-2">Документов</th>
                <th className="px-4 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {types.map(t => (
                <tr key={t.id} className={`border-b border-gray-50 hover:bg-gray-50 ${t.is_active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{t.name}</div>
                    <div className="text-[11px] text-gray-400">
                      {t.is_system && <span className="text-amber-600">системный · </span>}
                      {!t.is_active && 'выключен · '}
                      {t.code}
                    </div>
                  </td>
                  <td className="px-4 py-3"><PostingHint type={t} accounts={accounts} /></td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {[t.show_quantity && 'кол-во', t.show_price && 'цена', 'сумма', t.show_vat && 'НДС']
                      .filter(Boolean).join(', ')}
                    {t.line_head_fields?.length > 0 && (
                      <div className="text-[11px] text-blue-600 mt-0.5">
                        по строкам: {t.line_head_fields.map(f => {
                          if (f === 'bi') return 'счёт корр.'
                          const head = accounts.find(b => b.id == t.head_bi_id)
                          const type = head?.[`info_${f.slice(-1)}_type`]
                          return (INFO_LABELS[type] || f).toLowerCase()
                        }).join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600">{t.documents_count || '—'}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => startEdit(t)}
                      className="text-gray-300 hover:text-blue-600 p-1" title="Изменить">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                    </button>
                    {!t.is_system && (
                      <button onClick={() => remove(t)}
                        className="text-gray-300 hover:text-red-500 p-1" title="Удалить">×</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  )
}
