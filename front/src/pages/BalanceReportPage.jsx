import { Fragment, useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import Layout from '../components/Layout'
import { BusyLabel, SkeletonRows } from '../components/Busy'
import OperationsPeek from '../components/OperationsPeek'
import { getBalanceReport } from '../api/reports'
import { getProjects } from '../api/projects'
import { balanceSheetRows } from '../utils/reportSheets'
import { localDate } from '../utils/period'

/**
 * Управленческий баланс: что у компании есть и чьё это.
 *
 * Читают его не построчно, а двумя колонками: слева имущество и долги перед
 * нами, справа — на чьи деньги это куплено. Поэтому актив и пассив стоят рядом,
 * а не одним списком, как в оборотке: только так видно, что они равны.
 *
 * Сравнение с другой датой — не украшение: остаток сам по себе ничего не
 * говорит, вопрос всегда «стало больше или меньше, чем было».
 */

const fmt = (v) => {
  if (v == null || isNaN(v)) return '—'
  return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 })
}

/** Первое число текущего месяца — разумная дата сравнения по умолчанию */
const monthStart = () => {
  const d = new Date()
  return localDate(new Date(d.getFullYear(), d.getMonth(), 1))
}

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
      title: `${r.code ? r.code + ' ' : ''}${r.name}`,
      subtitle: mode === 'change'
        ? `Движение с ${report.compare_at} по ${report.at}`
        : `Последние операции по счёту на ${report.at}`,
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

  /** Одна строка раздела; дети — у строки прибыли */
  const row = (r, depth = 0) => (
    <Fragment key={`${r.bi_id ?? 'calc'}-${r.name}`}>
      <tr className="border-b border-gray-50 hover:bg-blue-50/40">
        <td className="py-1.5 pr-3 text-gray-700" style={{ paddingLeft: 12 + depth * 16 }}>
          {r.code && <span className="text-gray-400 mr-1.5 tabular-nums">{r.code}</span>}
          {r.name}
        </td>
        <td onClick={() => openPeek(r, 'saldo')}
          className={`py-1.5 px-3 text-right tabular-nums text-gray-800 ${r.bi_id ? 'cursor-pointer hover:underline' : ''}`}>
          {fmt(r.amount)}
        </td>
        {showCompare && (
          <>
            <td className="py-1.5 px-3 text-right tabular-nums text-gray-400">{fmt(r.compare_amount)}</td>
            <td onClick={() => openPeek(r, 'change')}
              className={`py-1.5 pl-3 pr-4 text-right tabular-nums ${
                (r.amount - r.compare_amount) >= 0 ? 'text-green-700' : 'text-red-600'
              } ${r.bi_id ? 'cursor-pointer hover:underline' : ''}`}>
              {fmt(r.amount - r.compare_amount)}
            </td>
          </>
        )}
      </tr>
      {(r.children || []).map(child => row(child, depth + 1))}
    </Fragment>
  )

  const column = (key, title) => (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-baseline justify-between">
        <h3 className="font-semibold text-gray-800">{title}</h3>
        <span className="text-sm tabular-nums font-semibold text-gray-700">
          {fmt(key === 'assets' ? report?.totals?.assets : report?.totals?.passive)} ₽
        </span>
      </div>

      <table className="w-full text-sm">
        <tbody>
          {side(key).map(section => (
            <Fragment key={section.key}>
              <tr className="bg-gray-50 border-y border-gray-100">
                <td className="py-1.5 px-3 font-medium text-gray-700">{section.label}</td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium text-gray-800">{fmt(section.total)}</td>
                {showCompare && (
                  <>
                    <td className="py-1.5 px-3 text-right tabular-nums text-gray-400">{fmt(section.compare_total)}</td>
                    <td className="py-1.5 pl-3 pr-4 text-right tabular-nums text-gray-500">
                      {fmt(section.total - section.compare_total)}
                    </td>
                  </>
                )}
              </tr>
              {(section.rows || []).map(r => row(r))}
              {!section.rows?.length && (
                <tr><td colSpan={showCompare ? 4 : 2} className="py-2 px-3 text-xs text-gray-400">пусто</td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <Layout>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="text-xl font-semibold text-gray-800">Баланс</h2>
        <BusyLabel active={loading}>Считаю баланс</BusyLabel>

        <div className="flex items-center gap-3 flex-wrap ml-auto">
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            На дату
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs bg-white" />
          </label>

          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            <input type="checkbox" className="rounded border-gray-300"
              checked={withCompare} onChange={e => setWithCompare(e.target.checked)} />
            сравнить с
            <input type="date" value={compare} disabled={!withCompare}
              onChange={e => setCompare(e.target.value)}
              className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs bg-white disabled:bg-gray-50 disabled:text-gray-400" />
          </label>

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

      {/* Закрытые должностью счета делают баланс неполным. Молчать об этом
          нельзя: человек искал бы ошибку в учёте там, где её нет */}
      {report?.partial && (
        <div className="bg-gray-50 border border-gray-200 text-gray-700 px-4 py-3 rounded-lg text-sm mb-4">
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

      {report && (
        <div className="grid gap-4 lg:grid-cols-2">
          {column('assets', 'Актив')}
          {column('passive', 'Пассив')}
        </div>
      )}

      {peek && <OperationsPeek {...peek} onClose={() => setPeek(null)} />}
    </Layout>
  )
}
