import { useEffect, useMemo, useState } from 'react'
import { getFundSchemes, getFundScheme, createFundScheme, updateFundScheme, deleteFundScheme } from '../api/fundSchemes'
import { getInfo } from '../api/info'
import Layout from '../components/Layout'
import FlowMultiSelect from '../components/FlowMultiSelect'

const ic = 'px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const DOW = [
  { v: 1, label: 'Понедельник' }, { v: 2, label: 'Вторник' }, { v: 3, label: 'Среда' },
  { v: 4, label: 'Четверг' }, { v: 5, label: 'Пятница' }, { v: 6, label: 'Суббота' }, { v: 0, label: 'Воскресенье' },
]

const DEFAULT_FUNDS = () => [
  { name: 'Фонд учредителя', percent: 10, flow_info_ids: [], opening_balance: 0 },
  { name: 'Фонд резервов', percent: 10, flow_info_ids: [], opening_balance: 0 },
  { name: 'Фонд себестоимости', percent: 30, flow_info_ids: [], opening_balance: 0 },
  { name: 'Фонд переменных расходов', percent: 10, flow_info_ids: [], opening_balance: 0 },
  { name: 'Фонд аренды', percent: 10, flow_info_ids: [], opening_balance: 0 },
  { name: 'Фонд ЗП', percent: 20, flow_info_ids: [], opening_balance: 0 },
  { name: 'Фонд рекламы', percent: 5, flow_info_ids: [], opening_balance: 0 },
  { name: 'Фонд прочих расходов', percent: 5, flow_info_ids: [], opening_balance: 0 },
]

const newScheme = () => ({
  id: null, name: 'Новая модель', note: '',
  week_start_dow: 5, start_date: null, income_flow_ids: [], funds: DEFAULT_FUNDS(),
})

export default function FundSchemesPage() {
  const [schemes, setSchemes] = useState([])
  const [scheme, setScheme] = useState(null)   // редактируемая модель
  const [flows, setFlows] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadList = async (selectId) => {
    const res = await getFundSchemes()
    const list = res.data.data || []
    setSchemes(list)
    return list
  }

  useEffect(() => {
    Promise.all([getFundSchemes(), getInfo({ type: 'flow' })])
      .then(([s, f]) => {
        const list = s.data.data || []
        setSchemes(list)
        setFlows(f.data.data || [])
        if (list.length > 0) selectScheme(list[0].id)
      })
      .finally(() => setLoading(false))
  }, [])

  const selectScheme = async (id) => {
    setError(''); setNotice('')
    const res = await getFundScheme(id)
    setScheme(res.data.data)
  }

  const startNew = () => { setError(''); setNotice(''); setScheme(newScheme()) }

  const patch = (p) => setScheme(s => ({ ...s, ...p }))
  const editFund = (i, p) => setScheme(s => ({ ...s, funds: s.funds.map((f, idx) => idx === i ? { ...f, ...p } : f) }))
  const addFund = () => setScheme(s => ({ ...s, funds: [...s.funds, { name: 'Новый фонд', percent: 0, flow_info_ids: [], opening_balance: 0 }] }))
  const removeFund = (i) => setScheme(s => ({ ...s, funds: s.funds.filter((_, idx) => idx !== i) }))

  const percentSum = useMemo(() => (scheme?.funds || []).reduce((a, f) => a + (parseFloat(f.percent) || 0), 0), [scheme])

  // Статьи ДДС, занятые другими фондами (для непересечения)
  const usedElsewhere = (idx) => {
    const set = new Set()
    ;(scheme?.funds || []).forEach((f, i) => { if (i !== idx) (f.flow_info_ids || []).forEach(id => set.add(String(id))) })
    return set
  }

  const save = async () => {
    setSaving(true); setError(''); setNotice('')
    try {
      const payload = {
        name: scheme.name, note: scheme.note || null,
        week_start_dow: scheme.week_start_dow ?? 5,
        start_date: scheme.start_date || null,
        income_flow_ids: scheme.income_flow_ids || [],
        funds: (scheme.funds || []).map(f => ({
          name: f.name, percent: parseFloat(f.percent) || 0,
          flow_info_ids: f.flow_info_ids || [], opening_balance: parseFloat(f.opening_balance) || 0,
        })),
      }
      const res = scheme.id ? await updateFundScheme(scheme.id, payload) : await createFundScheme(payload)
      setScheme(res.data.data)
      await loadList()
      setNotice('Модель сохранена')
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  const remove = async () => {
    if (!scheme?.id || !confirm(`Удалить модель «${scheme.name}»?`)) return
    await deleteFundScheme(scheme.id)
    const list = await loadList()
    setScheme(null)
    if (list.length > 0) selectScheme(list[0].id)
  }

  return (
    <Layout>
      <div className="py-2 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Модели распределения (фонды)</h1>
          <p className="text-sm text-gray-500 mt-1">
            Модель — это набор фондов с процентами распределения поступлений (в сумме 100%).
            Каждому фонду привязываются статьи ДДС; в пределах модели они не пересекаются.
          </p>
        </div>

        {error && <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}
        {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3">{notice}</div>}

        <div className="flex flex-col lg:flex-row gap-5 items-stretch lg:items-start">
          {/* Список моделей */}
          <div className="w-full lg:w-60 flex-shrink-0 bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h2 className="font-semibold text-gray-800 text-sm">Модели</h2>
              <button onClick={startNew} className="text-blue-600 text-sm hover:text-blue-700">+ Модель</button>
            </div>
            <div className="p-2">
              {schemes.length === 0 && <p className="text-sm text-gray-400 px-2 py-3">Пока нет моделей</p>}
              {schemes.map(s => (
                <button key={s.id} onClick={() => selectScheme(s.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 ${scheme?.id === s.id ? 'bg-blue-50 text-blue-900' : 'hover:bg-gray-50 text-gray-700'}`}>
                  <div className="font-medium truncate">{s.name}</div>
                  <div className="text-xs text-gray-400">
                    {s.funds_count} фонд(ов) · <span className={Math.abs(s.percent_sum - 100) < 0.01 ? '' : 'text-red-500'}>{s.percent_sum}%</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Редактор модели */}
          <div className="flex-1 min-w-0">
            {loading ? (
              <div className="text-sm text-gray-400 py-8 text-center">Загрузка…</div>
            ) : !scheme ? (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-10 text-center text-sm text-gray-400">
                Выберите модель слева или создайте новую.
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100">
                  <input className={`${ic} font-medium flex-1`} value={scheme.name} onChange={e => patch({ name: e.target.value })} placeholder="Название модели" />
                  {scheme.id && <button onClick={remove} className="text-sm text-gray-400 hover:text-red-600">Удалить</button>}
                  <button onClick={save} disabled={saving}
                    className="px-4 py-1.5 bg-blue-900 text-white rounded-lg text-sm hover:bg-blue-800 disabled:opacity-40">
                    {saving ? 'Сохранение…' : 'Сохранить'}
                  </button>
                </div>

                {/* Настройки модели */}
                <div className="flex items-center gap-4 flex-wrap px-5 py-3 border-b border-gray-100 bg-gray-50/60">
                  <label className="flex items-center gap-2 text-xs text-gray-500">Начало недели
                    <select className={ic} value={scheme.week_start_dow ?? 5} onChange={e => patch({ week_start_dow: Number(e.target.value) })}>
                      {DOW.map(d => <option key={d.v} value={d.v}>{d.label}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-gray-500">Учёт с
                    <input type="date" className={ic} value={scheme.start_date || ''} onChange={e => patch({ start_date: e.target.value || null })} />
                  </label>
                  <div className="flex items-center gap-2 text-xs text-gray-500">Статьи ДДС поступлений
                    <div className="w-64"><FlowMultiSelect options={flows} value={scheme.income_flow_ids || []} onChange={ids => patch({ income_flow_ids: ids })} placeholder="Поступления от клиентов…" /></div>
                  </div>
                </div>

                {/* Фонды */}
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[620px]">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-100">
                      <th className="text-left px-4 py-2 font-medium">Фонд</th>
                      <th className="text-right px-2 py-2 font-medium w-16">%</th>
                      <th className="text-left px-2 py-2 font-medium w-64">Статьи ДДС (расход)</th>
                      <th className="text-right px-2 py-2 font-medium w-28">Старт. остаток</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(scheme.funds || []).map((f, i) => {
                      const used = usedElsewhere(i)
                      const opts = flows.filter(o => !used.has(String(o.id)))
                      return (
                        <tr key={i} className="border-b border-gray-50 align-top">
                          <td className="px-4 py-2"><input className={`${ic} w-full`} value={f.name} onChange={e => editFund(i, { name: e.target.value })} /></td>
                          <td className="px-2 py-2 text-right"><input type="number" step="1" min="0" max="100" className={`${ic} w-16 text-right`} value={f.percent} onChange={e => editFund(i, { percent: e.target.value })} /></td>
                          <td className="px-2 py-2"><FlowMultiSelect options={opts} value={f.flow_info_ids || []} onChange={ids => editFund(i, { flow_info_ids: ids })} /></td>
                          <td className="px-2 py-2 text-right"><input type="number" step="1" className={`${ic} w-24 text-right`} value={f.opening_balance ?? 0} onChange={e => editFund(i, { opening_balance: e.target.value })} /></td>
                          <td className="px-2 py-2 text-right"><button onClick={() => removeFund(i)} className="text-gray-400 hover:text-red-600">✕</button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                      <td className="px-4 py-2 text-xs text-gray-600">Итого</td>
                      <td className={`px-2 py-2 text-right ${Math.abs(percentSum - 100) < 0.01 ? 'text-green-600' : 'text-red-600'}`}>{percentSum}%</td>
                      <td colSpan={3}></td>
                    </tr>
                  </tfoot>
                </table>
                </div>
                <div className="px-4 py-3 flex items-center justify-between">
                  <button onClick={addFund} className="text-blue-600 text-sm hover:text-blue-700">+ Фонд</button>
                  {Math.abs(percentSum - 100) >= 0.01 && <span className="text-xs text-red-600">Для сохранения сумма процентов должна быть 100%</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
