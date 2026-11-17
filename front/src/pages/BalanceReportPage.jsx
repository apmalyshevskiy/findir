import { Fragment, useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { AlertTriangle, Download, Info } from 'lucide-react'
import Layout from '../components/Layout'
import { BusyLabel, SkeletonRows } from '../components/Busy'
import OperationsPeek from '../components/OperationsPeek'
import { Button, ErrorState, PageHeader, Toggle } from '../components/ui'
import { getBalanceReport } from '../api/reports'
import { getProjects } from '../api/projects'
import { balanceSheetRows } from '../utils/reportSheets'
import { localDate } from '../utils/period'
import { moneyShort, date as fmtDate } from '../utils/format'

/**
 * Управленческий баланс: что у компании есть и чьё это.
 *
 * Читают его не построчно, а двумя колонками: слева имущество и долги перед
 * нами, справа — на чьи деньги это куплено. Поэтому актив и пассив стоят рядом,
 * а не одним списком, как в оборотке: только так видно, что они равны.
 *
 * Над колонками — то же самое словами: «имущества на столько-то, из них
 * столько-то в долг». Таблица баланса — язык бухгалтера; собственнику нужен
 * ответ, а уже потом строки, из которых он сложен.
 *
 * Сравнение с другой датой — не украшение: остаток сам по себе ничего не
 * говорит, вопрос всегда «стало больше или меньше, чем было».
 */

const fmt = (v) => {
  if (v == null || isNaN(v)) return '—'
  const n = Math.round(Number(v))
  return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('ru-RU')
}
// Изменение — со знаком всегда: «+500 000» читается как «стало больше»
const fmtDelta = (v) => {
  const n = Math.round(Number(v) || 0)
  if (n === 0) return '—'
  return (n > 0 ? '+' : '−') + Math.abs(n).toLocaleString('ru-RU')
}
const short = (v) => moneyShort(v)
const shortDelta = (v) => (v > 0 ? '+' : '') + moneyShort(v)

// Счета в плане заведены капсом — в отчёте это кричит. Аббревиатуры
// в смешанном регистре (написанные руками) не трогаем
const nice = (s) => (s && s === s.toUpperCase() && /[А-ЯЁA-Z]{3}/.test(s) ? s[0] + s.slice(1).toLowerCase() : s)

/** Первое число текущего месяца — разумная дата сравнения по умолчанию */
const monthStart = () => {
  const d = new Date()
  return localDate(new Date(d.getFullYear(), d.getMonth(), 1))
}

const SECTION_SUB = {
  assets: 'деньги, товары, долги клиентов, оборудование',
  liabilities: 'чужие деньги: что компания должна вернуть',
  capital: 'собственные деньги: вложения и заработанное',
}

const inputCls = 'h-8 px-2.5 border border-gray-200 rounded-lg text-xs bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500 disabled:bg-gray-50 disabled:text-gray-400'

export default function BalanceReportPage() {
  const [date, setDate]       = useState(() => localDate(new Date()))
  const [compare, setCompare] = useState(() => monthStart())
  const [withCompare, setWithCompare] = useState(true)
  const [projectId, setProjectId]     = useState('')
  const [projects, setProjects]       = useState([])

  const [report, setReport]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [peek, setPeek]       = useState(null)   // расшифровка строки

  useEffect(() => {
    getProjects().then(r => setProjects(r.data.data || r.data || [])).catch(() => setProjects([]))
  }, [])

  const load = () => {
    setLoading(true); setError('')

    getBalanceReport({
      date,
      ...(withCompare && compare ? { compare_date: compare } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    })
      .then(r => setReport(r.data))
      .catch(e => setError(e.response?.data?.message || 'Не удалось построить баланс'))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [date, compare, withCompare, projectId])

  const exportToExcel = () => {
    const { rows, widths } = balanceSheetRows(report)
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = widths
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Баланс')
    XLSX.writeFile(wb, `Balance_${date}.xlsx`)
  }

  const sections = report?.sections || []
  const side = (key) => sections.filter(s => s.side === key)
  const sec = (key) => sections.find(s => s.key === key) || { total: 0, compare_total: 0, rows: [] }
  const showCompare = !!report?.compare_at

  /**
   * Расшифровка строки баланса.
   *
   * Остаток на дату складывается из всех операций по счёту за всё время, и
   * показывать их разом бессмысленно. Поэтому клик по колонке «изменение»
   * открывает движение между двумя датами — ровно то, что объясняет разницу;
   * клик по самому остатку — последние операции по счёту до этой даты.
   */
  const openPeek = (r, mode) => {
    if (!r.bi_id) return   // строка прибыли: это результат, а не счёт

    setPeek({
      title: `${r.code ? r.code + ' ' : ''}${nice(r.name)}`,
      subtitle: mode === 'change'
        ? `Движение с ${fmtDate(report.compare_at)} по ${fmtDate(report.at)}`
        : `Последние операции по счёту на ${fmtDate(report.at)}`,
      params: {
        date_to: report.at,
        ...(mode === 'change' ? { date_from: report.compare_at } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      },
      // Счёт может стоять и в дебете, и в кредите — сервер такой фильтр одним
      // параметром не умеет, отбираем на месте
      filter: (op) => String(op.in_bi_id) === String(r.bi_id) || String(op.out_bi_id) === String(r.bi_id),
    })
  }

  // Строки, на которые стоит посмотреть: отрицательные остатки там, где их не бывает
  const warnings = sections.flatMap(s => (s.rows || []).filter(r => r.warning))

  const rowLabel = (r) => {
    if (!r.bi_id && r.children) return r.amount < 0 ? 'Убыток накопленным итогом' : 'Прибыль накопленным итогом'
    return nice(r.name)
  }

  /** Одна строка раздела; дети — у строки прибыли */
  const row = (r, depth = 0) => (
    <Fragment key={`${r.bi_id ?? 'calc'}-${r.name}-${r.note || ''}`}>
      <tr className="group border-b border-gray-100 last:border-0 hover:bg-brand-50/40">
        <td className="py-2 pr-3 text-gray-800" style={{ paddingLeft: 16 + depth * 18 }} title={r.hint || undefined}>
          <span className={depth ? 'text-gray-600' : ''}>{rowLabel(r)}</span>
          {r.note && (
            <span className={`ml-1.5 px-1.5 py-px rounded text-2xs font-medium whitespace-nowrap ${r.note === 'должны нам' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
              {r.note}
            </span>
          )}
          {r.warning && <AlertTriangle className="inline w-3.5 h-3.5 ml-1.5 align-[-2px] text-amber-500" aria-label="требует проверки" />}
          {r.code && <span className="ml-1.5 text-2xs text-gray-400 tabular-nums whitespace-nowrap">{r.code}</span>}
        </td>
        <td onClick={() => openPeek(r, 'saldo')}
          className={`py-2 px-3 text-right tabular-nums whitespace-nowrap ${r.warning ? 'text-red-600' : 'text-gray-900'} ${r.bi_id ? 'cursor-pointer hover:underline decoration-gray-300' : ''}`}>
          {fmt(r.amount)}
        </td>
        {showCompare && (
          <>
            <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-gray-400">{fmt(r.compare_amount)}</td>
            <td onClick={() => openPeek(r, 'change')}
              className={`py-2 pl-3 pr-4 text-right tabular-nums whitespace-nowrap text-gray-600 ${r.bi_id ? 'cursor-pointer hover:underline decoration-gray-300' : ''}`}>
              {fmtDelta(r.amount - r.compare_amount)}
            </td>
          </>
        )}
      </tr>
      {(r.children || []).map(child => row(child, depth + 1))}
    </Fragment>
  )

  const head = (
    <thead>
      <tr className="text-2xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
        <th className="py-2 pl-4 pr-3 text-left font-medium">Статья</th>
        <th className="py-2 px-3 text-right font-medium whitespace-nowrap">на {fmtDate(report?.at)}</th>
        {showCompare && <>
          <th className="py-2 px-3 text-right font-medium whitespace-nowrap">на {fmtDate(report?.compare_at)}</th>
          <th className="py-2 pl-3 pr-4 text-right font-medium">Изменение</th>
        </>}
      </tr>
    </thead>
  )

  const column = (key, title, sub) => {
    const total = key === 'assets' ? report?.totals?.assets : report?.totals?.passive
    const totalCmp = key === 'assets' ? report?.totals?.assets_compare : report?.totals?.passive_compare
    return (
      <div className="bg-white rounded-xl border border-gray-200/80 shadow-card overflow-hidden">
        <div className="px-4 pt-3 pb-2.5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <p className="text-xs text-gray-500">{sub}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            {head}
            <tbody>
              {side(key).map(section => (
                <Fragment key={section.key}>
                  <tr className="bg-gray-50/80 border-y border-gray-100">
                    <td className="py-2 pl-4 pr-3">
                      <div className="font-semibold text-gray-800">{section.label}</div>
                      {SECTION_SUB[section.key] && <div className="text-2xs text-gray-500">{SECTION_SUB[section.key]}</div>}
                    </td>
                    <td className={`py-2 px-3 text-right tabular-nums font-semibold whitespace-nowrap ${section.total < 0 ? 'text-red-600' : 'text-gray-900'}`}>{fmt(section.total)}</td>
                    {showCompare && (
                      <>
                        <td className="py-2 px-3 text-right tabular-nums text-gray-400 whitespace-nowrap">{fmt(section.compare_total)}</td>
                        <td className="py-2 pl-3 pr-4 text-right tabular-nums font-medium text-gray-700 whitespace-nowrap">
                          {fmtDelta(section.total - section.compare_total)}
                        </td>
                      </>
                    )}
                  </tr>
                  {(section.rows || []).map(r => row(r))}
                  {!section.rows?.length && (
                    <tr><td colSpan={showCompare ? 4 : 2} className="py-2 px-4 text-xs text-gray-400">нет остатков</td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-200 bg-brand-50/40">
                <td className="py-2.5 pl-4 pr-3 font-semibold text-gray-900">Итого {key === 'assets' ? 'актив' : 'пассив'}</td>
                <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-gray-900 whitespace-nowrap">{fmt(total)}</td>
                {showCompare && <>
                  <td className="py-2.5 px-3 text-right tabular-nums text-gray-500 whitespace-nowrap">{fmt(totalCmp)}</td>
                  <td className="py-2.5 pl-3 pr-4 text-right tabular-nums font-semibold text-gray-800 whitespace-nowrap">{fmtDelta(total - totalCmp)}</td>
                </>}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    )
  }

  // ── Сводка словами ──────────────────────────────────────────────────────
  const summary = () => {
    const assets = report.totals.assets
    const debt = sec('liabilities').total
    const own = sec('capital').total
    const profitRow = sec('capital').rows?.find(r => !r.bi_id && r.children)
    const debtShare = assets > 0 ? Math.max(0, Math.min(100, (debt / assets) * 100)) : 0
    const ownShare = 100 - debtShare

    const cards = [
      { label: 'Имущество', sub: 'чем владеет компания', value: assets, delta: assets - report.totals.assets_compare, tone: 'text-gray-900' },
      { label: 'Долги', sub: 'чужие деньги в деле', value: debt, delta: debt - sec('liabilities').compare_total, tone: 'text-amber-700' },
      { label: 'Собственные средства', sub: 'вложения и заработанное', value: own, delta: own - sec('capital').compare_total, tone: own < 0 ? 'text-red-600' : 'text-brand-800' },
    ]

    return (
      <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-5 mb-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {cards.map(c => (
            <div key={c.label}>
              <div className="text-xs text-gray-500">{c.label} · <span className="text-gray-400">{c.sub}</span></div>
              <div className={`text-2xl font-semibold tabular-nums tracking-tight ${c.tone}`}>{short(c.value)}</div>
              {showCompare && (
                <div className="text-xs text-gray-500 tabular-nums">
                  {Math.round(c.delta) === 0 ? 'без изменений' : `${shortDelta(c.delta)} с ${fmtDate(report.compare_at)}`}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Одна полоса: на какие деньги куплено имущество */}
        {assets > 0 && (
          <div className="mt-4">
            <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-100" aria-hidden="true">
              <div className="bg-amber-400" style={{ width: `${debtShare}%` }} />
              <div className="bg-brand-700" style={{ width: `${ownShare}%` }} />
            </div>
            <div className="flex justify-between mt-1 text-2xs text-gray-500">
              <span>долги {Math.round(debtShare)}%</span>
              <span>собственные {Math.round(ownShare)}%</span>
            </div>
          </div>
        )}

        <p className="mt-3 text-sm text-gray-700 leading-6 max-w-4xl">
          На {fmtDate(report.at)} у компании имущества на <b className="font-semibold">{short(assets)}</b>.{' '}
          {own >= 0
            ? <>Из них <b className="font-semibold">{short(debt)}</b> куплено на чужие деньги — это долги поставщикам, банкам, сотрудникам и бюджету, — а <b className="font-semibold">{short(own)}</b> принадлежат собственникам.</>
            : <span className="text-red-700">Долгов (<b className="font-semibold">{short(debt)}</b>) больше, чем имущества: собственные средства отрицательные, <b className="font-semibold">{short(own)}</b>. Обычно это значит, что накопленный убыток съел вложенный капитал.</span>}
          {profitRow && <> {profitRow.amount >= 0 ? 'Заработано' : 'Убыток'} накопленным итогом — {short(Math.abs(profitRow.amount))}
            {showCompare && Math.round(profitRow.amount - profitRow.compare_amount) !== 0 &&
              <>, из них за период {shortDelta(profitRow.amount - profitRow.compare_amount)}</>}.</>}
        </p>
      </div>
    )
  }

  return (
    <Layout>
      <PageHeader title="Баланс" subtitle="Чем владеет компания и на чьи деньги это куплено"
        actions={<>
          <BusyLabel active={loading}>Считаю баланс</BusyLabel>
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            На дату
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
          </label>
          <Toggle pressed={withCompare} onChange={setWithCompare}>Сравнить с</Toggle>
          <input type="date" value={compare} disabled={!withCompare} aria-label="Дата сравнения"
            onChange={e => setCompare(e.target.value)} className={inputCls} />
          {projects.length > 1 && (
            <select value={projectId} onChange={e => setProjectId(e.target.value)} className={inputCls}>
              <option value="">Все проекты</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <Button size="sm" icon={Download} onClick={exportToExcel} disabled={!report}>Excel</Button>
        </>} />

      {error && !report && <ErrorState text={error} onRetry={load} />}
      {error && report && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">{error}</div>
      )}

      {/* Закрытые должностью счета делают баланс неполным. Молчать об этом
          нельзя: человек искал бы ошибку в учёте там, где её нет */}
      {report?.partial && (
        <div className="flex gap-2 bg-gray-50 border border-gray-200 text-gray-700 px-4 py-3 rounded-lg text-sm mb-4">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-gray-400" aria-hidden="true" />
          Часть счетов закрыта для вашей должности — в балансе их нет, и актив с пассивом могут не сойтись.
        </div>
      )}

      {report && Math.abs(report.check) >= 0.005 && !report.partial && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 rounded-lg text-sm mb-4">
          Актив и пассив разошлись на {fmt(report.check)} ₽. Такого быть не должно —
          покажите это разработчику, данные в порядке, дело в расчёте.
        </div>
      )}

      {!report && loading && <SkeletonRows rows={8} />}

      {report && summary()}

      {report && warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
          <div className="flex items-center gap-1.5 font-medium mb-1">
            <AlertTriangle className="w-4 h-4" aria-hidden="true" /> Стоит проверить
          </div>
          <ul className="space-y-0.5">
            {warnings.map(w => (
              <li key={w.bi_id}>
                <button type="button" onClick={() => openPeek(w, 'saldo')} className="font-medium underline decoration-amber-300 hover:decoration-amber-700">
                  {nice(w.name)}
                </button>{' '}
                <span className="tabular-nums">{fmt(w.amount)} ₽</span> — {w.warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report && (
        <div className="grid gap-4 xl:grid-cols-2">
          {column('assets', 'Актив', 'Чем владеет компания и кто ей должен')}
          {column('passive', 'Пассив', 'На чьи деньги это куплено: долги и собственные средства')}
        </div>
      )}

      {report && (
        <p className="mt-3 text-xs text-gray-500">
          Нажмите на сумму, чтобы увидеть операции по счёту, на изменение — движение за период.
          Расчёты с контрагентами показаны развёрнуто: переплаты поставщикам — в активе, авансы покупателей — в пассиве.
        </p>
      )}

      {peek && <OperationsPeek {...peek} onClose={() => setPeek(null)} />}
    </Layout>
  )
}
