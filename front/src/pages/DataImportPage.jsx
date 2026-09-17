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
import { parseUtc } from '../utils/datetime'

/**
 * Загрузка данных из учётных систем — в два шага.
 *
 * Сначала показываем, что лежит в источнике, и в каком оно у нас состоянии;
 * человек отмечает нужное и только потом жмёт загрузку. Одной кнопкой «взять
 * всё» пользоваться страшно: непонятно, что изменится в учёте.
 *
 * Настройки живут отдельно — сюда заходят каждый день, туда один раз.
 */

// Когда шла загрузка — время сервера, а он в UTC; дата самой строки ниже это
// календарное число и сдвигать его нельзя
const fmtDateTime = (iso) => {
  if (!iso) return null
  const d = parseUtc(iso)
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
  // Смена ещё идёт: чеки в неё придут, и документ пришлось бы перепроводить
  // после каждой продажи
  open:    { label: 'ещё не закрыта', chip: 'bg-gray-100 text-gray-500 ring-gray-200',   row: 'bg-gray-50 opacity-70', pick: false, auto: false },
  empty:   { label: 'без продаж',     chip: 'bg-gray-100 text-gray-400 ring-gray-200',   row: 'bg-gray-50 opacity-70', pick: false, auto: false },
  // Точка продаж не заполнена в настройках — счетов, куда класть, нет
  unmapped:{ label: 'точка не настроена', chip: 'bg-amber-50 text-amber-900 ring-amber-200', row: 'bg-amber-50/40', pick: false, auto: false },
}

const ORDER = ['new', 'changed', 'deleted', 'loaded', 'unmapped', 'open', 'empty', 'locked']

/** Колонки по умолчанию — если драйвер своих не прислал */
const DEFAULT_COLUMNS = [
  { key: 'number',    label: 'Документ',  kind: 'text' },
  { key: 'date',      label: 'Дата',      kind: 'date' },
  { key: 'supplier',  label: 'Поставщик', kind: 'partner' },
  { key: 'warehouse', label: 'Склад',     kind: 'text' },
  { key: 'amount',    label: 'Сумма',     kind: 'money' },
]

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
        <h2 className="text-xl font-semibold text-gray-800">Загрузка из учётных систем</h2>
        <Link to="/integrations" className="text-sm text-blue-700 hover:underline">
          Настройка интеграций →
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
 * Что внутри объекта источника и как он ложится в учёт.
 *
 * Состав в проводки не переносится — и накладная, и смена идут одной строкой
 * на служебную позицию. Поэтому показываем обе стороны рядом: что было в
 * источнике и что из этого получилось у нас.
 *
 * Названия полей и колонок приходят с сервера: у накладной поставщик и
 * позиции, у смены точка и чеки. Разбирать здесь, что за сущность раскрыли,
 * значило бы держать на странице знание о каждой учётной системе.
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

  const cols = data.columns || {}

  return (
    <div className="grid gap-5 lg:grid-cols-2">

      {/* ── Что в источнике ─────────────────────────────────────── */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">{data.title || 'В источнике'}</div>

        <Facts rows={data.facts} className="mb-3" />

        {data.items?.length > 0 ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="py-1 pr-2 font-medium">{cols.name || 'Позиция'}</th>
                <th className="py-1 pr-2 font-medium text-right">{cols.quantity || 'Кол-во'}</th>
                <th className="py-1 pr-2 font-medium text-right">{cols.price || 'Цена'}</th>
                <th className="py-1 font-medium text-right">{cols.amount || 'Сумма'}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it, k) => (
                <tr key={k} className="border-t border-gray-100">
                  <td className="py-1 pr-2 text-gray-700">{it.name}</td>
                  {/* Второй столбец бывает и числом, и временем чека */}
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
          <div className="text-xs text-gray-400">Состав не указан</div>
        )}
      </div>

      {/* ── Что получится у нас ─────────────────────────────────── */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">
          {data.document_id ? 'Загружено как' : 'Ляжет в учёт как'}
        </div>

        <Facts rows={data.posting?.rows} />

        {data.note && <p className="text-[11px] text-gray-400 mt-2 max-w-md">{data.note}</p>}

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

/** Колонки, которые прижимаются вправо и набираются цифрами в колонку */
const NUMERIC = new Set(['money', 'count'])

/** Одна ячейка списка: как показать значение, говорит `kind` колонки */
function Cell({ row, col }) {
  const v = row[col.key]

  if (col.kind === 'money') return <>{money(v)} ₽</>
  if (col.kind === 'date')  return <span className="whitespace-nowrap">{fmtDate(v)}</span>
  if (col.kind === 'count') return <>{v ?? 0}</>

  if (col.kind === 'partner') {
    return (
      <span className="text-gray-700">
        {v || '—'}
        {row.inn && <span className="text-gray-400 text-xs"> · ИНН {row.inn}</span>}
      </span>
    )
  }

  return <span className="text-gray-800">{v || '—'}</span>
}

/** Список «подпись — значение»: и реквизиты источника, и будущая проводка */
function Facts({ rows, className = '' }) {
  if (!rows?.length) return null

  return (
    <dl className={`text-xs text-gray-600 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 ${className}`}>
      {rows.map((f, k) => (
        <Fragment key={k}>
          <dt className="text-gray-400 whitespace-nowrap">{f.label}</dt>
          <dd className="text-gray-800">{f.value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function ImportCard({ integration, onDone, onPeek }) {
  // Период у каждой интеграции свой: склады и банк закрывают в разные сроки
  const [period, setPeriod] = usePersistedPeriod(`import:${integration.id}`, 'month')

  const [rows, setRows]       = useState(null)   // null — список ещё не запрашивали
  const [columns, setColumns] = useState(DEFAULT_COLUMNS)
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
      setColumns(r.data.columns?.length ? r.data.columns : DEFAULT_COLUMNS)
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

      {/* Файловый обмен здесь не показываем периодом: за данными не мы ходим,
          а человек приносит файл — и делает это на своём экране */}
      {integration.kind === 'file' ? (
        <div className="text-sm text-gray-600">
          Загружается файлом выгрузки.{' '}
          <Link to="/onec-postings" className="text-blue-700 hover:underline font-medium">
            Открыть загрузку проводок
          </Link>
        </div>
      ) : !integration.is_ready ? (
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
              {busy === 'preview' ? 'Загружаю...' : 'Загрузить за период'}
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
                      {columns.map(c => (
                        <th key={c.key} className={`py-2 px-3 font-medium ${NUMERIC.has(c.kind) ? 'text-right' : ''}`}>
                          {c.label}
                        </th>
                      ))}
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
                            {columns.map((c, ci) => (
                              <td key={c.key}
                                  className={`py-2 px-3 ${NUMERIC.has(c.kind) ? 'text-right tabular-nums text-gray-800' : 'text-gray-600'}`}>
                                {/* Раскрывашка живёт в первой колонке, какой бы она ни была */}
                                {ci === 0 && (
                                  <button onClick={e => { e.stopPropagation(); toggleDetail(r.id) }}
                                    title="Показать состав"
                                    className="text-gray-400 hover:text-gray-700 mr-1.5 w-3 inline-block">
                                    {opened === r.id ? '▾' : '▸'}
                                  </button>
                                )}
                                <Cell row={r} col={c} />
                              </td>
                            ))}
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
                              <td colSpan={columns.length + 2} className="px-3 py-3">
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
