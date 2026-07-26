import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getFundSchemes } from '../api/fundSchemes'
import { getFundPlanDoc, saveFundPlanDoc } from '../api/funds'
import { getInfo } from '../api/info'
import Layout from '../components/Layout'

const DOW_SHORT = { 0: 'Вс', 1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб' }
const localDate = (d) => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return x.toISOString().slice(0, 10) }
const todayIso = () => localDate(new Date())
const weekStartFor = (dateIso, dow) => {
  const d = new Date(dateIso + 'T00:00:00'); const diff = (d.getDay() - dow + 7) % 7
  d.setDate(d.getDate() - diff); return localDate(d)
}
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d) }
const fmtShort = (iso) => { const [, m, d] = iso.split('-'); return `${d}.${m}` }
const money = (v) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(v || 0)
const ic = 'px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

// Поле суммы с триадами прямо во время ввода (курсор сохраняется по числу цифр)
const groupInt = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const fmtTyping = (v) => {
  let s = v == null ? '' : String(v)
  if (s === '') return ''
  const neg = s[0] === '-' ? '-' : ''
  s = s.replace('-', '')
  const dot = s.indexOf('.')
  return dot === -1 ? neg + groupInt(s) : neg + groupInt(s.slice(0, dot)) + ',' + s.slice(dot + 1)
}
const AmountInput = ({ value, onChange, className, placeholder }) => {
  const ref = useRef(null)
  const onInput = (e) => {
    const el = e.target
    const digitsBefore = el.value.slice(0, el.selectionStart).replace(/\D/g, '').length
    const clean = el.value.replace(/\s/g, '').replace(',', '.')
    if (clean !== '' && clean !== '-' && !/^-?\d*\.?\d*$/.test(clean)) return
    onChange(clean)
    const formatted = fmtTyping(clean)
    requestAnimationFrame(() => {
      if (!ref.current) return
      let seen = 0, pos = 0
      while (pos < formatted.length && seen < digitsBefore) { if (/\d/.test(formatted[pos])) seen++; pos++ }
      ref.current.setSelectionRange(pos, pos)
    })
  }
  return (
    <input ref={ref} type="text" inputMode="decimal" className={className} placeholder={placeholder}
      value={fmtTyping(value)} onChange={onInput} />
  )
}

let seq = 0
const lid = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`

export default function FundPlanningPage() {
  const navigate = useNavigate()
  const [schemes, setSchemes] = useState([])
  const [schemeId, setSchemeId] = useState(null)
  const [weekStart, setWeekStart] = useState(todayIso())
  const [flowName, setFlowName] = useState({})
  const [data, setData] = useState(null)   // ответ show
  const [lines, setLines] = useState([])   // редактируемые строки {_id, fund_id, flow_info_id, amount, comment}
  const [note, setNote] = useState('')
  const [status, setStatus] = useState('draft')
  const [percents, setPercents] = useState({})   // локальные проценты распределения {fund_id: %}
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    Promise.all([getFundSchemes(), getInfo({ type: 'flow' })]).then(([s, f]) => {
      const list = s.data.data || []
      setSchemes(list)
      setFlowName(Object.fromEntries((f.data.data || []).map(x => [x.id, x.name])))
      if (list.length > 0) { setSchemeId(list[0].id); setWeekStart(weekStartFor(todayIso(), list[0].week_start_dow ?? 5)) }
    }).finally(() => setLoading(false))
  }, [])

  const scheme = schemes.find(s => s.id === schemeId)
  const dow = scheme?.week_start_dow ?? 5
  const weekEnd = addDays(weekStart, 6)

  const loadDoc = () => {
    if (!schemeId || !weekStart) return
    getFundPlanDoc(schemeId, weekStart).then(r => {
      setData(r.data)
      setLines((r.data.doc?.lines || []).map(l => ({ ...l, _id: lid() })))
      setNote(r.data.doc?.note || '')
      setStatus(r.data.doc?.status || 'draft')
      const init = {}
      ;(r.data.funds || []).forEach(f => { init[f.id] = f.percent })
      if (r.data.doc?.fund_percents) Object.entries(r.data.doc.fund_percents).forEach(([k, v]) => { init[k] = Number(v) })
      setPercents(init)
    }).catch(() => setData(null))
  }
  useEffect(loadDoc, [schemeId, weekStart])

  const changeScheme = (id) => {
    setSchemeId(id)
    const s = schemes.find(x => x.id === id)
    setWeekStart(weekStartFor(weekStart, s?.week_start_dow ?? 5))
  }

  const incomePrior = data?.income_prior || 0
  const incomeWeek = data?.income_week || 0

  const linesOf = (fundId) => lines.filter(l => l.fund_id === fundId)
  const plannedAll = (fundId) => linesOf(fundId).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)
  const plannedAccepted = (fundId) => linesOf(fundId).filter(l => l.accepted).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)

  const round2 = (n) => Math.round(n * 100) / 100

  const pctOf = (f) => (percents[f.id] ?? f.percent ?? 0)
  const percentSum = round2((data?.funds || []).reduce((s, f) => s + pctOf(f), 0))

  const derive = (f) => {
    const pct = pctOf(f)
    const carriedIn = f.carried_in || 0          // Ост. начало (с учётом % прошлых недель, с бэкенда)
    const distributed = incomeWeek * pct / 100
    const spent = f.spent_week || 0
    const planned = plannedAccepted(f.id)        // в план идут только принятые строки
    const factAfter = carriedIn - spent          // Ост. конец = начало − факт (может быть отрицательным)
    const allowed = factAfter + distributed      // Разрешено = Ост. конец + распределение (переходит дальше)
    return {
      pct, carriedIn, distributed, spent, planned, factAfter, allowed,
      virtualAfter: allowed - planned,           // Ост. план = Разрешено − Запланировано
    }
  }

  // Ручной ввод % (без авто-перераспределения). Контроль 100% — подсветкой.
  const setPercent = (fundId, raw) => {
    let v = parseFloat(raw); if (isNaN(v)) v = 0
    v = Math.max(0, Math.min(100, v))
    setPercents(p => ({ ...p, [fundId]: round2(v) }))
  }
  const percentOk = Math.abs(percentSum - 100) < 0.01
  const resetPercents = () => {
    const init = {}; (data?.funds || []).forEach(f => { init[f.id] = f.percent }); setPercents(init)
  }

  const buildPayload = (src, st) => {
    const differ = (data?.funds || []).some(f => round2(percents[f.id] ?? f.percent) !== round2(f.percent))
    return {
      scheme_id: schemeId, week_start: weekStart, status: st ?? status, note: note || null,
      fund_percents: differ ? percents : null,
      lines: src.map(l => ({
        fund_id: l.fund_id, flow_info_id: l.flow_info_id || null,
        amount: parseFloat(l.amount) || 0, comment: l.comment || null, accepted: !!l.accepted,
      })),
    }
  }
  const persistLines = (src) => { saveFundPlanDoc(buildPayload(src)).then(() => setNotice('Сохранено')).catch(() => {}) }

  // «Запланировать»: строка со следующей статьёй и остатком к планированию (Разрешено − все строки). Строка непринятая.
  const planNext = (f) => {
    const articles = f.flow_info_ids || []
    if (articles.length === 0) return
    const remaining = Math.max(0, round2(derive(f).allowed - plannedAll(f.id)))
    const nextArticle = articles[linesOf(f.id).length] ?? articles[articles.length - 1]
    setLines(ls => [...ls, { _id: lid(), fund_id: f.id, flow_info_id: nextArticle, amount: remaining, comment: '', accepted: false }])
  }
  // Изменение суммы/статьи снимает «принято» — нужно подтвердить заново
  const editLine = (id, patch) => setLines(ls => ls.map(l => {
    if (l._id !== id) return l
    const unaccept = ('amount' in patch) || ('flow_info_id' in patch)
    return { ...l, ...patch, ...(unaccept ? { accepted: false } : {}) }
  }))
  const removeLine = (id) => { const next = lines.filter(l => l._id !== id); setLines(next); persistLines(next) }
  const toggleAccept = (id) => {
    const next = lines.map(l => l._id === id ? { ...l, accepted: !l.accepted } : l)
    setLines(next)
    persistLines(next)
  }

  const save = async (nextStatus) => {
    setSaving(true); setNotice('')
    try {
      const r = await saveFundPlanDoc(buildPayload(lines, nextStatus))
      setData(r.data)
      setLines((r.data.doc?.lines || []).map(l => ({ ...l, _id: lid() })))
      setStatus(r.data.doc?.status || 'draft')
      setNotice('Акт сохранён')
    } finally { setSaving(false) }
  }

  const totalPlanned = useMemo(() => (data?.funds || []).reduce((s, f) => s + derive(f).planned, 0), [data, lines])
  const totalAllowed = useMemo(() => (data?.funds || []).reduce((s, f) => s + derive(f).allowed, 0), [data, lines])
  const totalVirtual = useMemo(() => (data?.funds || []).reduce((s, f) => s + derive(f).virtualAfter, 0), [data, lines])

  const Stat = ({ label, value, cls = 'text-gray-800' }) => (
    <div className="text-right">
      <div className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls}`}>{money(value)}</div>
    </div>
  )

  return (
    <Layout>
      <div className="max-w-6xl mx-auto py-2 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Акт финансового планирования</h1>
            <p className="text-sm text-gray-500 mt-1">По каждому фонду планируем расходы (статья ДДС + сумма + комментарий). Остаток переходит на следующую неделю.</p>
          </div>
          <button onClick={() => navigate('/fund-schemes')} className="text-sm text-blue-600 hover:text-blue-700">Модели распределения →</button>
        </div>

        {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3">{notice}</div>}

        {loading ? (
          <div className="text-sm text-gray-400 py-8 text-center">Загрузка…</div>
        ) : schemes.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-10 text-center text-sm text-gray-500">
            Нет моделей распределения. <button onClick={() => navigate('/fund-schemes')} className="text-blue-600 hover:underline">Создайте модель</button>.
          </div>
        ) : (
          <>
            {/* Модель, неделя, статус */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-gray-600">Модель
                <select className={ic} value={schemeId || ''} onChange={e => changeScheme(Number(e.target.value))}>
                  {schemes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
                <button onClick={() => setWeekStart(addDays(weekStart, -7))} title="Предыдущая неделя"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:bg-white hover:text-gray-800 hover:shadow-sm transition-all">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <div className="text-sm font-medium text-gray-800 min-w-[170px] text-center px-2">
                  {DOW_SHORT[dow]} {fmtShort(weekStart)} — {DOW_SHORT[(dow + 6) % 7]} {fmtShort(weekEnd)}
                </div>
                <button onClick={() => setWeekStart(addDays(weekStart, 7))} title="Следующая неделя"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:bg-white hover:text-gray-800 hover:shadow-sm transition-all">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full ${status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                {status === 'approved' ? 'Утверждён' : 'Черновик'}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => save('draft')} disabled={saving} className="px-4 py-1.5 border border-gray-200 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-40">
                  {saving ? '…' : 'Сохранить'}
                </button>
                {status === 'approved'
                  ? <button onClick={() => save('draft')} disabled={saving} className="px-4 py-1.5 text-amber-600 text-sm hover:text-amber-700">Снять утверждение</button>
                  : <button onClick={() => save('approved')} disabled={saving} className="px-4 py-1.5 bg-blue-900 text-white rounded-lg text-sm hover:bg-blue-800 disabled:opacity-40">Утвердить</button>}
              </div>
            </div>

            {/* Поступление */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
              <span className="text-sm font-medium text-gray-600">Поступление за неделю (факт)</span>
              <div className="flex items-center gap-3">
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${percentOk ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {percentOk ? `Распределение: ${percentSum}%` : `⚠ Распределение: ${percentSum}% — должно быть 100%`}
                </span>
                <button onClick={resetPercents} className="text-xs text-gray-400 hover:text-gray-700">Сбросить %</button>
              </div>
              <span className="text-2xl font-bold text-blue-600">{money(incomeWeek)}</span>
            </div>

            {/* Фонды */}
            {(data?.funds || []).map(f => {
              const d = derive(f)
              const articles = f.flow_info_ids || []
              const fLines = linesOf(f.id)
              return (
                <div key={f.id} className="bg-white rounded-xl border border-gray-100 shadow-sm">
                  <div className="flex items-center gap-4 px-5 py-3 border-b border-gray-100 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-800">{f.name}</span>
                      <span className="flex items-center gap-1 text-sm text-gray-500">
                        <input type="number" step="1" min="0" max="100" value={d.pct}
                          onChange={e => setPercent(f.id, e.target.value)} title="Процент распределения"
                          className={`w-14 px-1.5 py-0.5 border rounded text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${percentOk ? 'border-gray-200' : 'border-red-300 bg-red-50'}`} />
                        %
                      </span>
                    </div>
                    <div className="ml-auto flex items-stretch gap-3 flex-wrap">
                      <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-1.5">
                        <div className="text-[9px] text-gray-400 uppercase tracking-wider mb-1 text-center">Факт · остатки</div>
                        <div className="flex items-center gap-4">
                          <Stat label="Ост. начало" value={d.carriedIn} />
                          <Stat label="Пред. план" value={f.planned_prev || 0} cls="text-gray-400" />
                          <Stat label="Факт" value={d.spent} cls="text-red-600" />
                          <Stat label="Ост. конец" value={d.factAfter} cls={d.factAfter < 0 ? 'text-gray-500' : 'text-gray-700'} />
                        </div>
                      </div>
                      <div className="rounded-lg bg-blue-50/50 border border-blue-100 px-3 py-1.5">
                        <div className="text-[9px] text-blue-400 uppercase tracking-wider mb-1 text-center">Текущее планирование</div>
                        <div className="flex items-center gap-4">
                          <Stat label="Распред." value={d.distributed} />
                          <Stat label="Разрешено" value={d.allowed} cls={d.allowed < 0 ? 'text-red-600' : 'text-green-700'} />
                          <Stat label="Заплан." value={d.planned} cls="text-blue-700" />
                          <Stat label="Ост. план" value={d.virtualAfter} cls={d.virtualAfter < 0 ? 'text-red-600' : 'text-gray-500'} />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="p-4">
                    {articles.length === 0 ? (
                      <p className="text-xs text-amber-600">У фонда нет статей ДДС — задайте их в модели, чтобы планировать расходы.</p>
                    ) : (
                      <>
                        {fLines.length === 0 && <p className="text-sm text-gray-400 pb-2">Нет запланированных расходов</p>}
                        {fLines.map(l => (
                          <div key={l._id} className={`flex items-center gap-2 mb-2 rounded-lg px-1.5 py-1 ${l.accepted ? 'bg-green-50 ring-1 ring-green-200' : ''}`}>
                            <button onClick={() => toggleAccept(l._id)} title={l.accepted ? 'Принято — нажмите, чтобы снять' : 'Принять'}
                              className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center border transition-colors ${l.accepted ? 'bg-green-600 border-green-600 text-white' : 'border-gray-300 text-gray-300 hover:border-green-500 hover:text-green-600'}`}>
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                            </button>
                            <select className={`${ic} w-80`} value={l.flow_info_id || ''} onChange={e => editLine(l._id, { flow_info_id: e.target.value ? Number(e.target.value) : null })}>
                              <option value="">— статья ДДС</option>
                              {articles.map(id => <option key={id} value={id}>{flowName[id] || `#${id}`}</option>)}
                            </select>
                            <AmountInput placeholder="Сумма"
                              className={`${ic} w-32 text-right ${l.accepted ? 'font-semibold text-green-700' : ''}`}
                              value={l.amount} onChange={v => editLine(l._id, { amount: v })} />
                            <input type="text" placeholder="Комментарий" className={`${ic} flex-1`} value={l.comment || ''} onChange={e => editLine(l._id, { comment: e.target.value })} />
                            <button onClick={() => removeLine(l._id)} className="text-gray-400 hover:text-red-600 px-1">✕</button>
                          </div>
                        ))}
                        <button onClick={() => planNext(f)} className="text-blue-600 text-sm hover:text-blue-700">Запланировать</button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Итоги */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4 flex items-center justify-between flex-wrap gap-3">
              <input className={`${ic} flex-1 min-w-[220px]`} placeholder="Примечание к акту" value={note} onChange={e => setNote(e.target.value)} />
              <div className="flex items-center gap-6 flex-wrap">
                <div className="text-right"><div className="text-[10px] text-gray-400 uppercase">Запланировано</div><div className="text-lg font-bold text-blue-700 tabular-nums">{money(totalPlanned)}</div></div>
                <div className="text-right"><div className="text-[10px] text-gray-400 uppercase">Разрешено (на фондах)</div><div className={`text-lg font-bold tabular-nums ${totalAllowed < 0 ? 'text-red-600' : 'text-gray-900'}`}>{money(totalAllowed)}</div></div>
                <div className="text-right"><div className="text-[10px] text-gray-400 uppercase">Остаток план</div><div className="text-lg font-bold text-gray-500 tabular-nums">{money(totalVirtual)}</div></div>
              </div>
            </div>
            <p className="text-xs text-gray-400">
              <b>Пред. план</b> — сколько было запланировано в акте прошлой недели (для сравнения с фактом). Последовательность по фонду:
              <b> Ост. начало</b> (деньги в фонде) − <b>Факт</b> (списание за неделю) = <b>Ост. конец</b>;
              затем + <b>Распределено</b> = <b>Разрешено</b> (доступные деньги фонда, переходят на следующую неделю).
              <b> Запланировано</b> — план расхода; <b>Ост. план</b> = Разрешено − Запланировано (сколько останется, если потратить план).
            </p>
          </>
        )}
      </div>
    </Layout>
  )
}
