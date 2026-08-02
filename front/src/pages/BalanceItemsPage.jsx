import { useEffect, useMemo, useState } from 'react'
import Layout from '../components/Layout'
import { getBalanceItemsList, createBalanceItem, updateBalanceItem, deleteBalanceItem } from '../api/balanceItems'

const ic = 'px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const lc = 'block text-[11px] text-gray-500 mb-0.5'

const INFO_TYPES = [
  { v: '',           label: '— нет' },
  { v: 'partner',    label: 'Контрагент' },
  { v: 'cash',       label: 'Касса/Счёт' },
  { v: 'flow',       label: 'Статья ДДС' },
  { v: 'revenue',    label: 'Статья дохода' },
  { v: 'expenses',   label: 'Статья расхода' },
  { v: 'product',    label: 'Товар/Услуга' },
  { v: 'employee',   label: 'Сотрудник' },
  { v: 'department', label: 'Отдел' },
]
const typeLabel = (v) => INFO_TYPES.find(t => t.v === (v || ''))?.label || v

const EMPTY = {
  code: '', name: '', parent_id: '',
  info_1_type: '', info_2_type: '', info_3_type: '',
  info_1_turnover_only: false, info_2_turnover_only: false, info_3_turnover_only: false,
  has_quantity: false,
}

/** Дерево по parent_id с отступами */
const flatten = (items) => {
  const byParent = {}
  items.forEach(i => { const p = i.parent_id ?? 0; (byParent[p] ||= []).push(i) })
  const out = []
  const walk = (pid, depth) => {
    ;(byParent[pid] || []).sort((a, b) => String(a.code).localeCompare(String(b.code)))
      .forEach(i => { out.push({ ...i, depth }); walk(i.id, depth + 1) })
  }
  walk(0, 0)
  // Сироты (родитель удалён) — чтобы ничего не потерялось
  const shown = new Set(out.map(i => i.id))
  items.filter(i => !shown.has(i.id)).forEach(i => out.push({ ...i, depth: 0 }))
  return out
}

export default function BalanceItemsPage() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(null)      // { ...поля, id? }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = () => getBalanceItemsList()
    .then(r => setItems(r.data.data || []))
    .finally(() => setLoading(false))

  useEffect(() => { load() }, [])

  const tree = useMemo(() => flatten(items), [items])

  const startNew = () => { setForm({ ...EMPTY }); setError(''); setNotice('') }
  const startEdit = (i) => {
    setError(''); setNotice('')
    setForm({
      id: i.id, code: i.code || '', name: i.name || '', parent_id: i.parent_id || '',
      info_1_type: i.info_1_type || '', info_2_type: i.info_2_type || '', info_3_type: i.info_3_type || '',
      info_1_turnover_only: !!i.info_1_turnover_only,
      info_2_turnover_only: !!i.info_2_turnover_only,
      info_3_turnover_only: !!i.info_3_turnover_only,
      has_quantity: !!i.has_quantity,
      is_system: !!i.is_system, operations_count: i.operations_count || 0,
    })
  }

  const save = async () => {
    if (!form.code.trim() || !form.name.trim()) return
    setSaving(true); setError(''); setNotice('')
    const payload = { ...form, parent_id: form.parent_id || null }
    delete payload.is_system; delete payload.operations_count
    try {
      if (form.id) await updateBalanceItem(form.id, payload)
      else await createBalanceItem(payload)
      setForm(null)
      await load()
      setNotice(form.id ? 'Счёт сохранён' : 'Счёт добавлен')
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  const remove = async (i) => {
    if (!confirm(`Удалить счёт «${i.code} ${i.name}»?`)) return
    setError(''); setNotice('')
    try {
      await deleteBalanceItem(i.id)
      await load()
      setNotice('Счёт удалён')
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось удалить')
    }
  }

  const analytics = (i) => [i.info_1_type, i.info_2_type, i.info_3_type]
    .filter(Boolean).map(typeLabel).join(' · ')

  return (
    <Layout>
      <div className="py-2 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">План счетов</h1>
            <p className="text-sm text-gray-500 mt-1">
              Счета учёта и их аналитика. Код счёта используется в карте разноски и при разборе
              выписки — менять его у задействованных счетов нельзя.
            </p>
          </div>
          <button onClick={startNew}
            className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
            + Счёт
          </button>
        </div>

        {error &&  <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}
        {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3">{notice}</div>}

        {/* Карточка счёта — окном по центру, чтобы не уезжала за экран при правке нижних строк */}
        {form && (
          <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4"
            onClick={() => setForm(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[88vh] overflow-y-auto p-4 space-y-3"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between sticky top-0 bg-white pb-2 -mt-1">
              <h2 className="text-sm font-semibold text-gray-800">
                {form.id ? `Счёт ${form.code}` : 'Новый счёт'}
              </h2>
              <button onClick={() => setForm(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
            </div>

            {form.is_system && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                Системный счёт: удалить нельзя, механизмы учёта на него опираются.
                {form.operations_count > 0 && <> По счёту уже {form.operations_count} операций.</>}
              </p>
            )}

            <div className="flex gap-3 flex-wrap">
              <div className="w-28">
                <span className={lc}>Код</span>
                <input className={`${ic} w-full`} value={form.code} placeholder="А100"
                  onChange={e => setForm(f => ({ ...f, code: e.target.value }))} />
              </div>
              <div className="flex-1 min-w-[220px]">
                <span className={lc}>Наименование</span>
                <input className={`${ic} w-full`} value={form.name} placeholder="ДЕНЕЖНЫЕ СРЕДСТВА"
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="min-w-[220px]">
                <span className={lc}>Родительский счёт</span>
                <select className={`${ic} w-full`} value={form.parent_id}
                  onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))}>
                  <option value="">— верхний уровень</option>
                  {tree.filter(o => o.id !== form.id).map(o => (
                    <option key={o.id} value={o.id}>{' '.repeat(o.depth * 2)}{o.code} {o.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Аналитика */}
            <div>
              <span className={lc}>Аналитика счёта (до трёх разрезов)</span>
              <div className="space-y-1.5">
                {[1, 2, 3].map(n => (
                  <div key={n} className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs text-gray-400 w-6">{n}.</span>
                    <select className={`${ic} min-w-[190px]`} value={form[`info_${n}_type`]}
                      onChange={e => setForm(f => ({ ...f, [`info_${n}_type`]: e.target.value }))}>
                      {INFO_TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
                    </select>
                    <label className={`flex items-center gap-1.5 text-xs ${form[`info_${n}_type`] ? 'text-gray-600' : 'text-gray-300'}`}>
                      <input type="checkbox" className="rounded" disabled={!form[`info_${n}_type`]}
                        checked={!!form[`info_${n}_turnover_only`]}
                        onChange={e => setForm(f => ({ ...f, [`info_${n}_turnover_only`]: e.target.checked }))} />
                      только обороты (без сальдо)
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" className="rounded" checked={!!form.has_quantity}
                onChange={e => setForm(f => ({ ...f, has_quantity: e.target.checked }))} />
              количественный учёт (в операциях появится количество)
            </label>

            <div className="flex gap-2 pt-1">
              <button onClick={save} disabled={saving || !form.code.trim() || !form.name.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">
                {saving ? '…' : form.id ? 'Сохранить' : 'Создать'}
              </button>
              <button onClick={() => setForm(null)}
                className="px-4 py-2 border border-gray-200 text-gray-600 rounded-lg text-sm hover:bg-gray-50">
                Отмена
              </button>
            </div>
          </div>
          </div>
        )}

        {/* Список */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
          {loading ? (
            <div className="text-sm text-gray-400 py-10 text-center">Загрузка…</div>
          ) : (
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-100">
                  <th className="text-left px-4 py-2 font-medium w-28">Код</th>
                  <th className="text-left px-3 py-2 font-medium">Наименование</th>
                  <th className="text-left px-3 py-2 font-medium">Аналитика</th>
                  <th className="text-right px-3 py-2 font-medium w-24">Операций</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {tree.map(i => (
                  <tr key={i.id} className="border-b border-gray-50 hover:bg-gray-50/60 group">
                    <td className="px-4 py-2 font-mono text-xs text-gray-700" style={{ paddingLeft: 16 + i.depth * 16 }}>
                      {i.depth > 0 && <span className="text-gray-300 mr-1">└</span>}{i.code}
                    </td>
                    <td className="px-3 py-2 text-gray-800">
                      {i.name}
                      {i.has_quantity && <span className="ml-2 text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">кол-во</span>}
                      {i.is_system && <span className="ml-2 text-[10px] text-gray-400">системный</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">{analytics(i) || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-gray-600">
                      {i.operations_count > 0 ? i.operations_count : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex gap-1">
                        <button onClick={() => startEdit(i)} title="Изменить"
                          className="text-gray-300 hover:text-gray-600 p-1 rounded hover:bg-gray-100">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                        </button>
                        {!i.is_system && (
                          <button onClick={() => remove(i)} title="Удалить"
                            className="text-gray-300 hover:text-red-500 p-1 rounded hover:bg-red-50 text-base leading-none">×</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}
