import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import PeriodPicker from '../components/PeriodPicker'
import usePersistedPeriod from '../hooks/usePersistedPeriod'
import { getIntegrations, runIntegrationSync, getIntegrationRuns } from '../api/integrations'

/**
 * Загрузка данных из учётных систем.
 *
 * Отделена от настроек намеренно: настройки заполняют один раз, а грузят
 * каждый день. Держать кнопку загрузки внутри формы с двумя десятками полей
 * значило заставлять человека каждый раз проходить мимо них.
 */

const fmtDateTime = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d) ? null : d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const STATUS = {
  ok:      { label: 'успешно',            cls: 'bg-green-50 text-green-700 ring-green-200' },
  warning: { label: 'с предупреждениями', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  error:   { label: 'ошибка',             cls: 'bg-red-50 text-red-700 ring-red-200' },
  running: { label: 'выполняется',        cls: 'bg-gray-50 text-gray-600 ring-gray-200' },
}

const Badge = ({ status }) => {
  const s = STATUS[status] || STATUS.running
  return <span className={`px-2 py-0.5 rounded text-[11px] font-medium ring-1 ${s.cls}`}>{s.label}</span>
}

export default function DataImportPage() {
  const [items, setItems] = useState(null)

  const load = () => getIntegrations().then(r => setItems(r.data.data || [])).catch(() => setItems([]))
  useEffect(() => { load() }, [])

  const active = (items || []).filter(i => i.is_active)

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <h2 className="text-xl font-semibold text-gray-800">Загрузка данных</h2>
        <Link to="/integrations" className="text-sm text-blue-700 hover:underline">
          Настройки интеграций →
        </Link>
      </div>

      {items === null && <div className="text-sm text-gray-400">Загружаю...</div>}

      {items !== null && active.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 max-w-2xl">
          <div className="text-sm text-gray-700 font-medium mb-1">Нет включённых интеграций</div>
          <p className="text-sm text-gray-500">
            Интеграция сама забирает данные из учётной системы и раскладывает их по счетам.
            Настроить нужно один раз — дальше сюда заходят только за загрузкой.
          </p>
          <Link to="/integrations"
            className="inline-block mt-4 px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
            Настроить интеграцию
          </Link>
        </div>
      )}

      <div className="space-y-4">
        {active.map(i => <ImportCard key={i.id} integration={i} onDone={load} />)}
      </div>
    </Layout>
  )
}

function ImportCard({ integration, onDone }) {
  // Период у каждой интеграции свой: склады и банк закрывают в разные сроки
  const [period, setPeriod] = usePersistedPeriod(`import:${integration.id}`, 'month')
  const [runs, setRuns]     = useState([])
  const [busy, setBusy]     = useState(false)
  const [notice, setNotice] = useState(null)
  const [showLog, setShowLog] = useState(false)

  const entities = Object.entries(integration.entities || {})
  const [entity, setEntity] = useState(entities[0]?.[0] || 'warehouse_invoice')

  const loadRuns = () => getIntegrationRuns(integration.id)
    .then(r => setRuns(r.data.data || [])).catch(() => setRuns([]))

  useEffect(() => { loadRuns() }, [integration.id])   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setBusy(true); setNotice(null)
    try {
      const r = await runIntegrationSync(integration.id, { entity, from: period.from, to: period.to })
      const res = r.data.data
      setNotice({ kind: res.status === 'warning' ? 'warn' : 'ok', text: res.message, details: res.details })
    } catch (e) {
      setNotice({
        kind: 'error',
        text: e.response?.data?.data?.message || e.response?.data?.message || 'Загрузка не удалась',
      })
    } finally {
      setBusy(false); loadRuns(); onDone()
    }
  }

  const noticeCls = {
    ok:    'bg-green-50 border-green-200 text-green-800',
    warn:  'bg-amber-50 border-amber-200 text-amber-900',
    error: 'bg-red-50 border-red-200 text-red-700',
  }

  const last = fmtDateTime(integration.last_run_at)

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 max-w-4xl">

      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="font-semibold text-gray-800">{integration.name}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {last
              ? <>последняя загрузка {last}{integration.last_run_message ? ` · ${integration.last_run_message}` : ''}</>
              : 'ещё ни разу не загружали'}
          </div>
        </div>
        {integration.last_run_status && <Badge status={integration.last_run_status} />}
      </div>

      {!integration.is_ready ? (
        <div className="border border-amber-200 bg-amber-50/60 rounded-lg px-4 py-3 text-sm text-amber-900">
          Не заполнено: {integration.missing.join(', ')}.{' '}
          <Link to="/integrations" className="text-blue-700 hover:underline font-medium">Открыть настройки</Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {entities.length > 1 && (
              <select value={entity} onChange={e => setEntity(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm">
                {entities.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            )}
            {entities.length === 1 && (
              <span className="text-sm text-gray-600">{entities[0][1]}</span>
            )}

            <PeriodPicker value={period} onChange={setPeriod} />

            <button onClick={run} disabled={busy}
              className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
              {busy ? 'Загружаю...' : '↓ Загрузить'}
            </button>
          </div>

          {busy && (
            <p className="text-[11px] text-gray-400 mt-2">
              Идёт обращение к учётной системе — на большом периоде это может занять минуту.
            </p>
          )}

          {notice && (
            <div className={`border rounded-lg px-4 py-3 text-sm mt-4 ${noticeCls[notice.kind]}`}>
              {notice.text}
              {notice.details?.length > 0 && (
                <ul className="mt-1.5 list-disc pl-4 space-y-0.5 text-[13px]">
                  {notice.details.map((d, k) => <li key={k}>{d}</li>)}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {runs.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100">
          <button onClick={() => setShowLog(!showLog)}
            className="text-xs text-gray-500 hover:text-gray-700">
            {showLog ? '▾' : '▸'} Прошлые загрузки ({runs.length})
          </button>

          {showLog && (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="py-1.5 pr-3 font-medium">Когда</th>
                    <th className="py-1.5 pr-3 font-medium">Период</th>
                    <th className="py-1.5 pr-3 font-medium">Итог</th>
                    <th className="py-1.5 font-medium">Состояние</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(r => (
                    <tr key={r.id} className="border-t border-gray-50 align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-gray-600">{fmtDateTime(r.started_at) || '—'}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap text-gray-500">
                        {String(r.period_from).slice(0, 10)} — {String(r.period_to).slice(0, 10)}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-700">
                        {r.message}
                        {r.details?.length > 0 && (
                          <ul className="mt-1 text-amber-800 list-disc pl-4 space-y-0.5">
                            {r.details.map((d, k) => <li key={k}>{d}</li>)}
                          </ul>
                        )}
                      </td>
                      <td className="py-1.5"><Badge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
