import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import PeriodPicker from '../components/PeriodPicker'
import DocumentPeek from '../components/DocumentPeek'
import usePersistedPeriod from '../hooks/usePersistedPeriod'
import {
  getIntegrations, previewIntegration, runIntegrationSync, getIntegrationRuns,
  getIntegrationObject,
} from '../api/integrations'

/**
 * Загрузка данных из учётных систем — в два шага.
 *
 * Сначала показываем, что лежит в источнике, и в каком оно у нас состоянии;
 * человек отмечает нужное и только потом жмёт загрузку. Одной кнопкой «взять
 * всё» пользоваться страшно: непонятно, что изменится в учёте.
 *
 * Настройки живут отдельно — сюда заходят каждый день, туда один раз.
 */

const fmtDateTime = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d) ? null : d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const fmtDate = (s) => {
  if (!s) return '—'
  const [y, m, d] = String(s).slice(0, 10).split('-')
  return d ? `${d}.${m}.${y}` : s
}

const money = (v) => Number(v ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Состояния строки. Порядок здесь — порядок в сводке над таблицей:
 * сначала то, что требует действия, потом спокойное.
 */
const ROW_STATUS = {
  new:     { label: 'новая',          chip: 'bg-blue-50 text-blue-800 ring-blue-200',    row: '',                 pick: true,  auto: true },
  changed: { label: 'изменилась',     chip: 'bg-amber-50 text-amber-900 ring-amber-200', row: '',                 pick: true,  auto: true },
  deleted: { label: 'удалена в POS',  chip: 'bg-red-50 text-red-700 ring-red-200',       row: '',                 pick: true,  auto: true },
  // Отметить можно и уже загруженную — перезальётся заново. Просто не сама:
  // без нужды перепроводить документ незачем
  loaded:  { label: 'уже загружена',  chip: 'bg-green-50 text-green-700 ring-green-200', row: 'bg-green-50/40',   pick: true,  auto: false },
  locked:  { label: 'период закрыт',  chip: 'bg-gray-100 text-gray-500 ring-gray-200',   row: 'bg-gray-50 opacity-70', pick: false, auto: false },
}

const ORDER = ['new', 'changed', 'deleted', 'loaded', 'locked']

const RUN_STATUS = {
  ok:      { label: 'успешно',            cls: 'bg-green-50 text-green-700 ring-green-200' },
  warning: { label: 'с предупреждениями', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  error:   { label: 'ошибка',             cls: 'bg-red-50 text-red-700 ring-red-200' },
  running: { label: 'выполняется',        cls: 'bg-gray-50 text-gray-600 ring-gray-200' },
}

const Badge = ({ status }) => {
  const s = RUN_STATUS[status] || RUN_STATUS.running
  return <span className={`px-2 py-0.5 rounded text-[11px] font-medium ring-1 ${s.cls}`}>{s.label}</span>
}

export default function DataImportPage() {
  const [items, setItems] = useState(null)
  // Документ смотрим окном поверх страницы: уходить со списка посреди разбора
  // и заново запрашивать период — лишняя работа
  const [peekId, setPeekId] = useState(null)

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
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8">
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
        {active.map(i => (
          <ImportCard key={i.id} integration={i} onDone={load} onPeek={setPeekId} />
        ))}
      </div>

      {peekId && <DocumentPeek id={peekId} onClose={() => setPeekId(null)} />}
    </Layout>
  )
}

/**
 * Что внутри накладной и как она ложится в учёт.
 *
 * Состав в проводки не переносится — вся накладная идёт одной строкой на
 * служебную позицию. Поэтому показываем обе стороны рядом: что закупили и
 * что из этого получилось у нас.
 */
function ObjectDetail({ integrationId, entity, externalId, onPeek }) {
  const [data, setData]   = useState(null)
  const [error, setError] = useState('')

  // Сбрасывать состояние не нужно: key по накладной даёт новый экземпляр,
  // а значит и чистое состояние на каждое раскрытие
  useEffect(() => {
    let alive = true

    getIntegrationObject(integrationId, { entity, external_id: externalId })
      .then(r => { if (alive) setData(r.data.data) })
      .catch(e => { if (alive) setError(e.response?.data?.message || 'Не удалось получить состав') })

    return () => { alive = false }
  }, [integrationId, entity, externalId])

  if (error)  return <div className="text-sm text-red-600">{error}</div>
  if (!data)  return <div className="text-sm text-gray-400">Запрашиваю состав...</div>

  const p = data.posting || {}

  return (
    <div className="grid gap-5 lg:grid-cols-2">

      {/* ── Что в источнике ─────────────────────────────────────── */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">В накладной</div>

        <dl className="text-xs text-gray-600 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-3">
          <dt className="text-gray-400">Поставщик</dt>
          <dd className="text-gray-800">
            {data.supplier || '—'}
            {data.inn && <span className="text-gray-500"> · ИНН {data.inn}</span>}
            {data.kpp && <span className="text-gray-500"> · КПП {data.kpp}</span>}
          </dd>

          <dt className="text-gray-400">Склад</dt>
          <dd>{data.warehouse || '—'}</dd>

          <dt className="text-gray-400">Юрлицо</dt>
          <dd>{data.legal_entity || '—'}</dd>

          {data.processed_at && <><dt className="text-gray-400">Проведена</dt><dd>{data.processed_at}</dd></>}
          {data.vat_amount > 0 && <><dt className="text-gray-400">В том числе НДС</dt><dd>{money(data.vat_amount)} ₽</dd></>}
          {data.comment && <><dt className="text-gray-400">Комментарий</dt><dd>{data.comment}</dd></>}
        </dl>

        {data.items?.length > 0 ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="py-1 pr-2 font-medium">Позиция</th>
                <th className="py-1 pr-2 font-medium text-right">Кол-во</th>
                <th className="py-1 pr-2 font-medium text-right">Цена</th>
                <th className="py-1 font-medium text-right">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it, k) => (
                <tr key={k} className="border-t border-gray-100">
                  <td className="py-1 pr-2 text-gray-700">{it.name}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-gray-600">{it.quantity}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-gray-600">{money(it.price)}</td>
                  <td className="py-1 text-right tabular-nums text-gray-800">{money(it.amount)}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-200 font-medium">
                <td className="py-1 pr-2 text-gray-700" colSpan={3}>Итого</td>
                <td className="py-1 text-right tabular-nums text-gray-900">{money(data.amount)} ₽</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div className="text-xs text-gray-400">Позиции не указаны</div>
        )}
      </div>

      {/* ── Что получится у нас ─────────────────────────────────── */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">
          {data.document_id ? 'Загружено как' : 'Ляжет в учёт как'}
        </div>

        <dl className="text-xs text-gray-600 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-gray-400">Проект</dt>
          <dd className="text-gray-800">{p.project || '—'}</dd>

          <dt className="text-gray-400">Дебет</dt>
          <dd className="text-gray-800">{p.debit || '—'}</dd>

          <dt className="text-gray-400">Кредит</dt>
          <dd className="text-gray-800">{p.credit || '—'}</dd>

          <dt className="text-gray-400">Номенклатура</dt>
          <dd>{p.product || '—'}</dd>

          <dt className="text-gray-400">Количество</dt>
          <dd className="tabular-nums">{money(p.quantity)}</dd>

          <dt className="text-gray-400">Цена</dt>
          <dd className="tabular-nums">{money(p.price)} ₽</dd>

          <dt className="text-gray-400">Сумма</dt>
          <dd className="tabular-nums text-gray-900 font-medium">{money(p.amount)} ₽</dd>
        </dl>

        <p className="text-[11px] text-gray-400 mt-2 max-w-md">
          Позиции накладной в проводки не переносятся: вся сумма идёт одной
          строкой на служебную номенклатуру по цене 1 ₽, поэтому количество на
          складском счёте равно рублям.
        </p>

        {data.document_id && (
          <button onClick={() => onPeek(data.document_id)}
            className="mt-3 px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-blue-700 hover:bg-white">
            Посмотреть документ
          </button>
        )}
      </div>
    </div>
  )
}

function ImportCard({ integration, onDone, onPeek }) {
  // Период у каждой интеграции свой: склады и банк закрывают в разные сроки
  const [period, setPeriod] = usePersistedPeriod(`import:${integration.id}`, 'month')

  const [rows, setRows]       = useState(null)   // null — список ещё не запрашивали
  const [picked, setPicked]   = useState(() => new Set())
  const [runs, setRuns]       = useState([])
  const [busy, setBusy]       = useState('')
  const [notice, setNotice]   = useState(null)
  const [showLog, setShowLog] = useState(false)
  const [opened, setOpened]   = useState(null)   // раскрытая строка состава

  const toggleDetail = (id) => setOpened(prev => (prev === id ? null : id))

  const entities = Object.entries(integration.entities || {})
  const [entity, setEntity] = useState(entities[0]?.[0] || 'warehouse_invoice')

  const loadRuns = () => getIntegrationRuns(integration.id)
    .then(r => setRuns(r.data.data || [])).catch(() => setRuns([]))

  useEffect(() => { loadRuns() }, [integration.id])   // eslint-disable-line react-hooks/exhaustive-deps

  // Смена периода обесценивает показанный список — убираем, чтобы не грузить
  // по нему то, чего в новом периоде нет
  useEffect(() => {
    setRows(null); setPicked(new Set()); setNotice(null); setOpened(null)
  }, [period.from, period.to, entity])

  const counts = useMemo(() => {
    const c = {}
    for (const r of rows || []) c[r.status] = (c[r.status] || 0) + 1
    return c
  }, [rows])

  const selectable = (rows || []).filter(r => ROW_STATUS[r.status]?.pick)

  const show = async () => {
    setBusy('preview'); setNotice(null)
    try {
      const r = await previewIntegration(integration.id, { entity, from: period.from, to: period.to })
      const list = r.data.data || []
      setRows(list)
      // По умолчанию отмечаем то, что что-то изменит: уже загруженное трогать
      // незачем, но отметить его вручную можно
      setPicked(new Set(list.filter(x => ROW_STATUS[x.status]?.auto).map(x => x.id)))
      if (list.length === 0) setNotice({ kind: 'ok', text: 'За этот период в источнике ничего нет' })
    } catch (e) {
      setNotice({ kind: 'error', text: e.response?.data?.message || 'Не удалось получить список' })
    } finally { setBusy('') }
  }

  const run = async () => {
    setBusy('sync'); setNotice(null)
    try {
      const r = await runIntegrationSync(integration.id, {
        entity, from: period.from, to: period.to, ids: [...picked],
      })
      const res = r.data.data
      setNotice({ kind: res.status === 'warning' ? 'warn' : 'ok', text: res.message, details: res.details })
      await show()          // показываем обновлённые пометки
    } catch (e) {
      setNotice({
        kind: 'error',
        text: e.response?.data?.data?.message || e.response?.data?.message || 'Загрузка не удалась',
      })
    } finally { setBusy(''); loadRuns(); onDone() }
  }

  const toggle = (id) => setPicked(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const allPicked = selectable.length > 0 && selectable.every(r => picked.has(r.id))
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(selectable.map(r => r.id)))

  const noticeCls = {
    ok:    'bg-green-50 border-green-200 text-green-800',
    warn:  'bg-amber-50 border-amber-200 text-amber-900',
    error: 'bg-red-50 border-red-200 text-red-700',
  }

  const last = fmtDateTime(integration.last_run_at)

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">

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
          {/* ── Шаг 1: что брать и за какой период ──────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            {entities.length > 1 ? (
              <select value={entity} onChange={e => setEntity(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm">
                {entities.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            ) : (
              <span className="text-sm text-gray-600">{entities[0]?.[1]}</span>
            )}

            <PeriodPicker value={period} onChange={setPeriod} />

            <button onClick={show} disabled={busy === 'preview'}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {busy === 'preview' ? 'Смотрю...' : 'Показать за период'}
            </button>
          </div>

          {busy === 'preview' && (
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

          {/* ── Шаг 2: список с отметками ───────────────────────────── */}
          {rows !== null && rows.length > 0 && (
            <div className="mt-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-2">
                {ORDER.filter(s => counts[s]).map(s => (
                  <span key={s} className="text-xs text-gray-600 flex items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[11px] ring-1 ${ROW_STATUS[s].chip}`}>
                      {ROW_STATUS[s].label}
                    </span>
                    {counts[s]}
                  </span>
                ))}
              </div>

              <div className="overflow-x-auto border border-gray-100 rounded-lg">
                <table className="w-full text-sm min-w-[860px]">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr className="text-left">
                      <th className="py-2 px-3 w-8">
                        <input type="checkbox" className="w-4 h-4 accent-blue-900"
                          checked={allPicked} onChange={toggleAll}
                          disabled={selectable.length === 0} />
                      </th>
                      <th className="py-2 px-3 font-medium">Документ</th>
                      <th className="py-2 px-3 font-medium">Дата</th>
                      <th className="py-2 px-3 font-medium">Поставщик</th>
                      <th className="py-2 px-3 font-medium">Склад</th>
                      <th className="py-2 px-3 font-medium text-right">Сумма</th>
                      <th className="py-2 px-3 font-medium">Состояние</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const st  = ROW_STATUS[r.status] || ROW_STATUS.new
                      const can = st.pick
                      return (
                        <Fragment key={r.id}>
                          <tr onClick={() => can && toggle(r.id)}
                              className={`border-t border-gray-50 ${st.row} ${can ? 'cursor-pointer hover:bg-blue-50/40' : ''}`}>
                            <td className="py-2 px-3">
                              <input type="checkbox" className="w-4 h-4 accent-blue-900"
                                checked={picked.has(r.id)} disabled={!can}
                                onChange={() => toggle(r.id)}
                                onClick={e => e.stopPropagation()} />
                            </td>
                            <td className="py-2 px-3">
                              <button onClick={e => { e.stopPropagation(); toggleDetail(r.id) }}
                                title="Показать состав накладной"
                                className="text-gray-400 hover:text-gray-700 mr-1.5 w-3 inline-block">
                                {opened === r.id ? '▾' : '▸'}
                              </button>
                              <span className="text-gray-800">{r.number || '—'}</span>
                            </td>
                            <td className="py-2 px-3 text-gray-600 whitespace-nowrap">{fmtDate(r.date)}</td>
                            <td className="py-2 px-3 text-gray-700">
                              {r.supplier || '—'}
                              {r.inn && <span className="text-gray-400 text-xs"> · ИНН {r.inn}</span>}
                            </td>
                            <td className="py-2 px-3 text-gray-600">{r.warehouse || '—'}</td>
                            <td className="py-2 px-3 text-right tabular-nums text-gray-800">{money(r.amount)} ₽</td>
                            <td className="py-2 px-3 whitespace-nowrap">
                              <span className={`px-2 py-0.5 rounded text-[11px] font-medium ring-1 ${st.chip}`}>
                                {st.label}
                              </span>
                              {r.document_id && (
                                <button onClick={e => { e.stopPropagation(); onPeek(r.document_id) }}
                                  className="text-blue-700 hover:underline text-xs ml-2">
                                  документ
                                </button>
                              )}
                            </td>
                          </tr>

                          {opened === r.id && (
                            <tr className="border-t border-gray-50 bg-gray-50/60">
                              <td colSpan={7} className="px-3 py-3">
                                <ObjectDetail
                                  key={r.id}
                                  integrationId={integration.id}
                                  entity={entity}
                                  externalId={r.id}
                                  onPeek={onPeek}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center gap-3 mt-3">
                <button onClick={run} disabled={busy === 'sync' || picked.size === 0}
                  className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
                  {busy === 'sync' ? 'Загружаю...' : `↓ Загрузить отмеченные (${picked.size})`}
                </button>
                <span className="text-[11px] text-gray-400">
                  Уже загруженные не отмечены — они не менялись. Отметьте, если
                  нужно перезалить: документ перепроведётся заново, дубля не будет.
                </span>
              </div>
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
                        {fmtDate(r.period_from)} — {fmtDate(r.period_to)}
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
