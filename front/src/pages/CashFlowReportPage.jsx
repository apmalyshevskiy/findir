import { Fragment, useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import Layout from '../components/Layout'
import PeriodPicker from '../components/PeriodPicker'
import usePersistedPeriod from '../hooks/usePersistedPeriod'
import { BusyLabel, SkeletonRows } from '../components/Busy'
import OperationsPeek from '../components/OperationsPeek'
import { getCashFlowReport } from '../api/reports'
import { getProjects } from '../api/projects'
import { cashFlowSheetRows } from '../utils/reportSheets'

/**
 * ОДДС прямым методом: откуда деньги пришли и куда ушли.
 *
 * Отчёт читают сверху вниз как рассказ: было столько-то, операционная работа
 * принесла или съела, вложили столько, заняли столько — стало столько-то.
 * Поэтому остатки стоят рамкой вокруг разделов, а не отдельной строкой сбоку.
 *
 * Переводы между своими кассами сюда не попадают: это не движение денег
 * компании, а их перекладывание. Считает это сервер.
 */

const fmt = (v) => {
  if (v == null || isNaN(v) || Number(v) === 0) return '—'
  return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 })
}

export default function CashFlowReportPage() {
  const [period, setPeriod] = usePersistedPeriod('cashflow', 'month')
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects]   = useState([])

  const [report, setReport]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [peek, setPeek]       = useState(null)   // расшифровка строки

  useEffect(() => {
    getProjects().then(r => setProjects(r.data.data || r.data || [])).catch(() => setProjects([]))
  }, [])

  const load = () => {
    setLoading(true); setError('')

    getCashFlowReport({
      date_from: period.from, date_to: period.to,
      ...(projectId ? { project_id: projectId } : {}),
    })
      .then(r => setReport(r.data))
      .catch(e => setError(e.response?.data?.message || 'Не удалось построить отчёт'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [period.from, period.to, projectId])

  const exportToExcel = () => {
    const { rows, widths } = cashFlowSheetRows(report)
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = widths
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ОДДС')
    XLSX.writeFile(wb, `CashFlow_${period.from}_${period.to}.xlsx`)
  }

  const toggle = (key) => setCollapsed(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  /**
   * Расшифровка статьи: операции за период по денежным счетам.
   *
   * Сервер отбирает по статье шире, чем нужно отчёту, — она может стоять и на
   * неденежной стороне проводки. Поэтому оставляем только те операции, где
   * денежный счёт действительно участвует.
   */
  const openPeek = (item) => {
    const cash = new Set((report?.cash_bi_ids || []).map(String))

    setPeek({
      title: item.name,
      subtitle: `Движение денег за период с ${period.from} по ${period.to}`,
      params: {
        date_from: period.from, date_to: period.to,
        ...(item.id ? { info_id: item.id } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      },
      filter: (op) => cash.has(String(op.in_bi_id)) || cash.has(String(op.out_bi_id)),
    })
  }

  /** Строка статьи; свёрнутая ветка показывает итог поддерева */
  const row = (item, sectionKey, depth = 0) => {
    const key = `${sectionKey}:${item.id}`
    const hasChildren = !!item.children?.length
    const open = !collapsed.has(key)

    return (
      <Fragment key={key}>
        <tr className={`border-b border-gray-50 hover:bg-blue-50/40 ${item.unassigned ? 'bg-amber-50/70' : ''}`}>
          <td className="py-1.5 pr-3 text-gray-700" style={{ paddingLeft: 12 + depth * 18 }}>
            <span className="inline-flex items-center gap-1.5">
              {hasChildren ? (
                <button onClick={() => toggle(key)} className="text-gray-400 hover:text-gray-600 w-3">
                  {open ? '▾' : '▸'}
                </button>
              ) : <span className="w-3" />}
              {/* Подпорка — статья другого вида деятельности, стоящая здесь
                  только ради своих детей: своей суммы у неё в этом разделе нет */}
              <span className={item.scaffold ? 'text-gray-400' : ''}>{item.name}</span>
            </span>
          </td>
          {/* Щелчок по сумме — операции, из которых она сложилась */}
          <td onClick={() => openPeek(item)}
            className="py-1.5 px-3 text-right tabular-nums text-green-700 cursor-pointer hover:underline">
            {fmt(item.sub_in)}
          </td>
          <td onClick={() => openPeek(item)}
            className="py-1.5 px-3 text-right tabular-nums text-red-600 cursor-pointer hover:underline">
            {fmt(item.sub_out)}
          </td>
          <td className={`py-1.5 pl-3 pr-4 text-right tabular-nums ${
            item.sub_net >= 0 ? 'text-gray-800' : 'text-red-600'
          }`}>{fmt(item.sub_net)}</td>
        </tr>
        {open && (item.children || []).map(child => row(child, sectionKey, depth + 1))}
      </Fragment>
    )
  }

  const totalRow = (label, value, tone = 'text-gray-800') => (
    <tr className="bg-gray-50 border-y border-gray-200 font-semibold">
      <td className="py-2 px-3 text-gray-700">{label}</td>
      <td /><td />
      <td className={`py-2 pl-3 pr-4 text-right tabular-nums ${tone}`}>{fmt(value)}</td>
    </tr>
  )

  return (
    <Layout>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="text-xl font-semibold text-gray-800">Движение денег</h2>
        <BusyLabel active={loading}>Считаю движение</BusyLabel>

        <div className="flex items-center gap-3 flex-wrap ml-auto">
          <PeriodPicker value={period} onChange={setPeriod} align="right" />

          {projects.length > 1 && (
            <select value={projectId} onChange={e => setProjectId(e.target.value)}
              className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs bg-white">
              <option value="">Все проекты</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}

          <button onClick={exportToExcel} disabled={!report}
            className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            Экспорт в Excel
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">{error}</div>
      )}

      {report?.message && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 rounded-lg text-sm mb-4">
          {report.message}
        </div>
      )}

      {report?.partial && (
        <div className="bg-gray-50 border border-gray-200 text-gray-700 px-4 py-3 rounded-lg text-sm mb-4">
          Часть счетов закрыта для вашей должности — движение по ним в отчёт не попало.
        </div>
      )}

      {!report && loading && <SkeletonRows rows={8} />}

      {report && !report.message && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 border-b border-gray-100">
                <th className="text-left font-medium py-2 px-3">Статья</th>
                <th className="text-right font-medium py-2 px-3 w-40">Поступления</th>
                <th className="text-right font-medium py-2 px-3 w-40">Выплаты</th>
                <th className="text-right font-medium py-2 pl-3 pr-4 w-40">Чистый поток</th>
              </tr>
            </thead>
            <tbody>
              {totalRow('Остаток на начало', report.opening)}

              {(report.sections || []).map(section => (
                <Fragment key={section.key}>
                  <tr className="bg-gray-100 border-y border-gray-200">
                    <td className="py-2 px-3 font-semibold text-gray-700">{section.label}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-semibold text-green-700">{fmt(section.in)}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-semibold text-red-600">{fmt(section.out)}</td>
                    <td className={`py-2 pl-3 pr-4 text-right tabular-nums font-semibold ${
                      section.net >= 0 ? 'text-gray-800' : 'text-red-600'
                    }`}>{fmt(section.net)}</td>
                  </tr>
                  {(section.rows || []).map(item => row(item, section.key))}
                </Fragment>
              ))}

              {totalRow('Чистый поток за период', report.net, report.net >= 0 ? 'text-green-700' : 'text-red-600')}
              {totalRow('Остаток на конец', report.closing)}
            </tbody>
          </table>
        </div>
      )}

      {peek && <OperationsPeek {...peek} onClose={() => setPeek(null)} />}

      {report && !report.message && (
        <p className="text-[11px] text-gray-400 mt-3">
          Переводы между своими кассами и счетами в отчёт не входят: деньги не пришли
          и не ушли, они переложены. Вид деятельности у статьи задаётся в справочнике.
        </p>
      )}
    </Layout>
  )
}
