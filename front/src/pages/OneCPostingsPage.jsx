import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import InfoItemCard from '../components/InfoItemCard'
import { INFO_LABELS } from '../utils/infoLabels'
import { getBalanceItemsList } from '../api/balanceItems'
import { getInfo } from '../api/info'
import {
  getOneCSettings, saveOneCSettings, saveOneCAnalytics,
  previewOneCPostings, importOneCPostings,
} from '../api/onec'

/**
 * Загрузка проводок из 1С:Бухгалтерии.
 *
 * Две вкладки, потому что это две разные работы. «Проводки» — то, ради чего
 * пришли: посмотреть и загрузить. «Соответствие» — настройка, которую делают
 * один раз и потом почти не открывают. Держать её всё время перед глазами
 * значило отодвигать проводки на второй экран.
 *
 * Привязать аналитику можно с обеих сторон, и это одно и то же действие: щелчок
 * по аналитике в проводке открывает то же окно, что и строка на вкладке
 * соответствия. Привязка живёт на субконто, а не на проводке, поэтому она
 * сразу применяется ко всем проводкам с этим субконто — об этом окно и
 * предупреждает.
 */

const STATUS = {
  new:       { label: 'новая',               chip: 'bg-blue-50 text-blue-800 ring-blue-200',    pick: true,  auto: true },
  changed:   { label: 'изменилась',          chip: 'bg-amber-50 text-amber-900 ring-amber-200', pick: true,  auto: true },
  // Отметить можно и загруженную — перезальётся. Просто не сама: без нужды
  // переписывать операцию незачем
  loaded:    { label: 'уже загружена',       chip: 'bg-green-50 text-green-700 ring-green-200', pick: true,  auto: false },
  unmapped:  { label: 'счёт не сопоставлен', chip: 'bg-red-50 text-red-700 ring-red-200',       pick: false, auto: false },
  forbidden: { label: 'счёт закрыт',         chip: 'bg-gray-100 text-gray-500 ring-gray-200',   pick: false, auto: false },
  locked:    { label: 'период закрыт',       chip: 'bg-gray-100 text-gray-500 ring-gray-200',   pick: false, auto: false },
}

const ORDER = ['new', 'changed', 'unmapped', 'forbidden', 'locked', 'loaded']

/** Как разрешилось субконто — словами, а не кодом источника. */
const SOURCE = {
  binding: { label: 'по привязке',     cls: 'text-violet-700' },
  inn:     { label: 'по ИНН',          cls: 'text-green-700' },
  name:    { label: 'по наименованию', cls: 'text-green-700' },
}

const money = (v) => Number(v ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (s) => {
  if (!s) return '—'
  const [y, m, d] = String(s).slice(0, 10).split('-')
  return d ? `${d}.${m}.${y}` : s
}

const inputCls = 'px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

const Chip = ({ status }) => {
  const s = STATUS[status] || STATUS.new
  return <span className={`px-2 py-0.5 rounded text-[11px] font-medium ring-1 whitespace-nowrap ${s.chip}`}>{s.label}</span>
}

const Field = ({ label, value }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
    <div className="text-gray-800 font-medium">{value ?? '—'}</div>
  </div>
)

export default function OneCPostingsPage() {
  const fileInput = useRef(null)

  const [file, setFile]       = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState('')
  const [result, setResult]   = useState(null)
  const [tab, setTab]         = useState('postings')

  const [integrations, setIntegrations] = useState([])
  const [integrationId, setIntegrationId] = useState('')
  const [chart, setChart]     = useState([])
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState('')

  const [accMap, setAccMap] = useState({})
  const [infoByType, setInfoByType] = useState({})

  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [picked, setPicked] = useState({})

  const [binding, setBinding]   = useState(null)  // ключ субконто, которое правим
  const [creating, setCreating] = useState(null)  // {key, name, type} — заводим элемент

  useEffect(() => {
    getBalanceItemsList().then(r => setChart(r.data.data || r.data || [])).catch(() => {})
    loadSettings()
  }, [])

  const loadSettings = (id) => getOneCSettings(id ? { integration_id: id } : {})
    .then(r => {
      const d = r.data.data || {}
      setIntegrations(d.integrations || [])
      setProjects(d.projects || [])
      setIntegrationId(d.integration_id ? String(d.integration_id) : '')
      setProjectId(d.project_id ? String(d.project_id) : '')
    })
    .catch(e => setError(e.response?.data?.message || 'Не удалось прочитать настройки'))

  /** Список аналитик одного типа — читаем по мере надобности и один раз. */
  const ensureType = (type) => {
    if (!type || infoByType[type]) return
    getInfo({ type })
      .then(r => setInfoByType(prev => ({ ...prev, [type]: r.data.data || [] })))
      .catch(() => {})
  }

  const run = (f, id = integrationId) => {
    setBusy(true); setError(''); setResult(null)

    previewOneCPostings(f, id)
      .then(r => {
        const d = r.data.data
        setPreview(d)
        setIntegrationId(String(d.integration_id))
        setProjectId(d.project_id ? String(d.project_id) : '')

        const acc = {}
        ;(d.accounts || []).forEach(a => {
          acc[a.account] = a.bi_id ? String(a.bi_id) : (a.skipped ? 'skip' : '')
        })
        setAccMap(acc)

        // Типы, которые понадобятся спискам аналитики этого файла
        ;[...new Set((d.subconto || []).flatMap(s => s.types || []))].forEach(ensureType)

        const pick = {}
        ;(d.rows || []).forEach(row => { if (STATUS[row.status]?.auto) pick[row.id] = true })
        setPicked(pick)

        // Пока счета не разобраны, грузить нечего — начинаем с соответствия
        const notSet = (d.accounts || []).filter(a => !a.bi_id && !a.skipped).length
        setTab(notSet > 0 ? 'mapping' : 'postings')
      })
      .catch(e => { setPreview(null); setError(e.response?.data?.message || 'Не удалось разобрать файл') })
      .finally(() => setBusy(false))
  }

  const choose = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    run(f)
  }

  const saveAccounts = () => {
    setSaving(true); setError('')

    saveOneCSettings({
      integration_id: integrationId || null,
      project_id: projectId ? Number(projectId) : null,
      accounts: Object.entries(accMap).map(([account, v]) => ({
        account,
        mode:  v === 'skip' ? 'skip' : (v ? 'bind' : 'auto'),
        bi_id: v && v !== 'skip' ? Number(v) : null,
      })),
    })
      .then(() => { setSaved(true); if (file) run(file) })
      .catch(e => setError(e.response?.data?.message || 'Не удалось сохранить соответствие счетов'))
      .finally(() => setSaving(false))
  }

  /**
   * Привязка одного субконто применяется сразу.
   *
   * Здесь нет кнопки «сохранить»: правка приходит по одной, из проводки или из
   * списка, и копить её незачем — человек хочет увидеть результат тут же.
   */
  const applyBind = (sub, mode, infoId = null) => {
    setBusy(true); setError('')

    saveOneCAnalytics({
      integration_id: integrationId || null,
      items: [{ kind: sub.kind, name: sub.name, mode, info_id: infoId }],
    })
      .then(() => { setBinding(null); if (file) run(file) })
      .catch(e => setError(e.response?.data?.message || 'Не удалось сохранить привязку'))
      .finally(() => setBusy(false))
  }

  const rows     = preview?.rows || []
  const subconto = preview?.subconto || []

  const subByKey = useMemo(
    () => Object.fromEntries(subconto.map(s => [s.key, s])),
    [subconto],
  )

  const selected = useMemo(
    () => rows.filter(r => picked[r.id] && STATUS[r.status]?.pick),
    [rows, picked],
  )

  const load = () => {
    if (!selected.length) return
    setBusy(true); setError(''); setResult(null)

    importOneCPostings(file, selected.map(r => r.id), integrationId)
      .then(r => { setResult(r.data.data); run(file) })
      .catch(e => setError(e.response?.data?.message || 'Не удалось загрузить проводки'))
      .finally(() => setBusy(false))
  }

  const stats     = preview?.stats || {}
  const notSet    = (preview?.accounts || []).filter(a => !a.bi_id && !a.skipped).length
  const unresolved = subconto.filter(s => !s.info_id && s.source !== 'binding').length

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <h2 className="text-xl font-semibold text-gray-800">Проводки из 1С</h2>
        <div className="flex items-center gap-4">
          <Link to="/integrations" className="text-sm text-blue-700 hover:underline">Настройка интеграций →</Link>
          {preview && (
            <button onClick={() => fileInput.current?.click()} className="text-sm text-blue-700 hover:underline">
              Выбрать другой файл
            </button>
          )}
        </div>
      </div>

      <input ref={fileInput} type="file" accept=".json,application/json" onChange={choose} className="hidden" />

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm">{error}</div>
      )}

      {!preview && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8">
          <div className="text-sm text-gray-700 font-medium mb-1">Выгрузка проводок из 1С:Бухгалтерии</div>
          <p className="text-sm text-gray-500 max-w-2xl">
            Файл готовит внешняя обработка «Выгрузка проводок в FINDIR» — она лежит в папке
            <span className="font-medium text-gray-700"> 1c</span> в составе системы. Здесь файл только
            разбирается: пока вы не нажмёте загрузку, в учёте ничего не меняется.
          </p>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="mt-4 px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
            {busy ? 'Разбираю…' : 'Выбрать файл выгрузки'}
          </button>
        </div>
      )}

      {preview && (
        <div className="space-y-4">
          <FileCard meta={preview.meta} stats={stats} problems={preview.problems} name={file?.name} />

          <SetupCard
            integrations={integrations}
            integrationId={integrationId}
            onIntegration={(id) => { setIntegrationId(id); loadSettings(id); if (file) run(file, id) }}
            projects={projects}
            projectId={projectId}
            onProject={setProjectId}
            onSave={saveAccounts}
            saving={saving}
          />

          <Tabs
            tab={tab}
            onTab={setTab}
            counts={{ postings: stats.total, notSet, unresolved }}
          />

          {tab === 'mapping' ? (
            <>
              <AccountsCard
                accounts={preview.accounts}
                chart={chart}
                value={accMap}
                onChange={(account, v) => { setAccMap(p => ({ ...p, [account]: v })); setSaved(false) }}
                onSave={saveAccounts}
                saving={saving}
                saved={saved}
                notSet={notSet}
              />

              <AnalyticsCard subconto={subconto} onOpen={setBinding} />
            </>
          ) : (
            <>
              {result && <ResultCard result={result} />}

              <PostingsCard
                rows={rows}
                picked={picked}
                onPick={(id, on) => setPicked(p => ({ ...p, [id]: on }))}
                onPickAll={(on) => {
                  const next = {}
                  rows.forEach(r => { if (STATUS[r.status]?.pick) next[r.id] = on })
                  setPicked(next)
                }}
                onBind={setBinding}
                stats={stats}
              />

              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={load}
                  disabled={busy || !selected.length || !projectId}
                  className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
                  {busy ? 'Загружаю…' : `Загрузить отмеченные (${selected.length})`}
                </button>

                {!projectId && (
                  <span className="text-sm text-red-700">Сначала выберите проект — проводки 1С проекта не знают</span>
                )}
                {projectId && !selected.length && (
                  <span className="text-sm text-gray-500">Нечего загружать: отметьте проводки в таблице</span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {binding && subByKey[binding] && (
        <BindModal
          sub={subByKey[binding]}
          infoByType={infoByType}
          ensureType={ensureType}
          busy={busy}
          onApply={(mode, infoId) => applyBind(subByKey[binding], mode, infoId)}
          onCreate={(type) => { setCreating({ ...subByKey[binding], type }); setBinding(null) }}
          onClose={() => setBinding(null)}
        />
      )}

      {creating && (
        <InfoItemCard
          infoType={creating.type}
          items={infoByType[creating.type] || []}
          initialName={creating.name}
          onSaved={(item) => {
            setInfoByType(prev => ({ ...prev, [creating.type]: [...(prev[creating.type] || []), item] }))
            const sub = creating
            setCreating(null)
            applyBind(sub, 'bind', item.id)
          }}
          onClose={() => setCreating(null)}
        />
      )}
    </Layout>
  )
}

/** Две работы — два экрана: посмотреть и загрузить, либо настроить. */
function Tabs({ tab, onTab, counts }) {
  const item = (key, label, badge, badgeCls) => (
    <button
      onClick={() => onTab(key)}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 ${
        tab === key
          ? 'border-b-blue-700 text-blue-800'
          : 'border-b-transparent text-gray-500 hover:text-gray-700'
      }`}>
      {label}
      {badge > 0 && (
        <span className={`px-1.5 py-0.5 rounded text-[11px] ring-1 ${badgeCls}`}>{badge}</span>
      )}
    </button>
  )

  return (
    <div className="flex gap-2 border-b border-gray-200">
      {item('postings', 'Проводки', counts.postings, 'bg-gray-100 text-gray-600 ring-gray-200')}
      {item('mapping', 'Соответствие',
        counts.notSet || counts.unresolved,
        counts.notSet ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-50 text-amber-800 ring-amber-200')}
    </div>
  )
}

/**
 * Привязка одного субконто.
 *
 * Вид аналитики спрашиваем только когда он неочевиден. Если счёт сопоставлен и
 * слот у него один — тип известен, и лишний вопрос человеку не задаём. Если
 * счёт ещё не разобран или слотов несколько, выбрать тип придётся, и выбрать
 * можно любой: справочник заводят под задачу, а не под наши догадки.
 */
function BindModal({ sub, infoByType, ensureType, busy, onApply, onCreate, onClose }) {
  const suggested = sub.types || []

  // Открываемся на виде уже подобранного элемента, иначе на единственном слоте
  // счёта. Спрашиваем только когда не угадать
  const [type, setType] = useState(sub.info_type || (suggested.length === 1 ? suggested[0] : ''))
  const [search, setSearch] = useState('')

  useEffect(() => { if (type) ensureType(type) }, [type])

  const items = (infoByType[type] || []).filter(i => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (i.name || '').toLowerCase().includes(q) || (i.code || '').toLowerCase().includes(q)
  })

  const src = SOURCE[sub.source]

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}>

        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-gray-800">{sub.name}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {sub.kind}
              {sub.code && <span className="ml-2">код {sub.code}</span>}
              {sub.inn && <span className="ml-2">ИНН {sub.inn}</span>}
              <span className="ml-2">· встречается {sub.count} раз</span>
            </div>
            <div className="text-xs mt-1">
              {sub.info_name
                ? <>сейчас: <span className="text-gray-700">{sub.info_name}</span>{src && <span className={`ml-1 ${src.cls}`}>({src.label})</span>}</>
                : <span className="text-amber-800">сейчас: {sub.reason || 'не переносится'}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">&times;</button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          <div>
            <span className="block text-[11px] text-gray-500 mb-1">
              Вид аналитики
              {suggested.length > 0 && (
                <span className="ml-1 text-gray-400">
                  — у счёта {(sub.accounts || []).join(', ')} слоты: {suggested.map(t => INFO_LABELS[t] || t).join(', ')}
                </span>
              )}
            </span>
            <select className={`${inputCls} w-full`} value={type}
              onChange={e => { setType(e.target.value); setSearch('') }}>
              <option value="">— выберите вид —</option>
              {Object.entries(INFO_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}{suggested.includes(k) ? ' — подходит счёту' : ''}
                </option>
              ))}
            </select>
            {type && !suggested.includes(type) && suggested.length > 0 && (
              <div className="text-xs text-amber-800 mt-1">
                У счёта нет слота этого вида — привязка сохранится, но в проводку не подставится.
              </div>
            )}
          </div>

          {type && (
            <>
              <input type="text" className={`${inputCls} w-full`} placeholder="Поиск по названию или коду"
                value={search} onChange={e => setSearch(e.target.value)} />

              <div className="border border-gray-100 rounded-lg max-h-64 overflow-y-auto">
                {items.length === 0 && (
                  <div className="px-3 py-3 text-sm text-gray-400">
                    Ничего не найдено — заведите новый элемент
                  </div>
                )}
                {items.map(i => (
                  <button key={i.id} type="button" disabled={busy}
                    onClick={() => onApply('bind', i.id)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-gray-50 last:border-0 flex justify-between gap-2 ${
                      String(i.id) === String(sub.info_id) ? 'bg-violet-50' : ''
                    }`}>
                    <span className="truncate">{i.name}</span>
                    {i.code && <span className="text-gray-400 text-xs shrink-0">{i.code}</span>}
                  </button>
                ))}
              </div>

              <button type="button" onClick={() => onCreate(type)} disabled={busy}
                className="w-full px-3 py-2 border border-blue-200 text-blue-700 rounded-lg text-sm hover:bg-blue-50 disabled:opacity-50">
                + Создать «{sub.name}» как {(INFO_LABELS[type] || type).toLowerCase()}
              </button>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex gap-2 flex-wrap">
          <button type="button" onClick={() => onApply('auto')} disabled={busy}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
            Искать по наименованию
          </button>
          <button type="button" onClick={() => onApply('skip')} disabled={busy}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
            Не переносить
          </button>
          <span className="text-xs text-gray-400 flex-1 min-w-[12rem] self-center">
            Привязка применится ко всем проводкам с этим субконто.
          </span>
        </div>
      </div>
    </div>
  )
}

/** Что за файл: откуда, за какой период и что в нём. */
function FileCard({ meta, stats, problems, name }) {
  const org = meta?.organization?.name
  const p   = meta?.period

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Field label="Файл" value={name} />
        {org && <Field label="Организация" value={org} />}
        {p && <Field label="Период выгрузки" value={`${fmtDate(p.from)} — ${fmtDate(p.to)}`} />}
        <Field label="Проводок" value={stats.total} />
        <Field label="Сумма" value={money(stats.amount)} />
      </div>

      {problems?.length > 0 && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          <div className="font-medium mb-1">В файле есть испорченные проводки ({problems.length})</div>
          <ul className="space-y-0.5">
            {problems.slice(0, 10).map((pr, i) => (
              <li key={i}>{pr.line ? `проводка ${pr.line}: ${pr.message}` : `… и ещё ${pr.more}`}</li>
            ))}
          </ul>
          <p className="mt-2 text-amber-800">
            Такие проводки в загрузку не попадут. Сумма по файлу посчитана без них.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Куда грузим: какая 1С-база и на какой проект.
 *
 * Выбор базы показываем только когда их несколько: список из одного варианта
 * ничего не сообщает, а место занимает.
 */
function SetupCard({ integrations, integrationId, onIntegration, projects, projectId, onProject, onSave, saving }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-end gap-3 flex-wrap">
        {integrations.length > 1 && (
          <div>
            <div className="text-sm font-medium text-gray-800 mb-1">База 1С</div>
            <select className={inputCls} value={integrationId} onChange={e => onIntegration(e.target.value)}>
              {integrations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <div className="text-sm font-medium text-gray-800 mb-1">Проект</div>
          <select className={inputCls} value={projectId} onChange={e => onProject(e.target.value)}>
            <option value="">— выберите —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <button
          onClick={onSave}
          disabled={saving}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
          Запомнить
        </button>

        <p className="text-sm text-gray-500 flex-1 min-w-[16rem]">
          Все загруженные проводки лягут на этот проект: в 1С проектов нет.
        </p>
      </div>
    </div>
  )
}

/** Счёт 1С → счёт FINDIR. Заполняется один раз и сохраняется. */
function AccountsCard({ accounts, chart, value, onChange, onSave, saving, saved, notSet }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-clip">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-gray-800">Счета</div>
          <p className="text-sm text-gray-500">
            {notSet > 0
              ? `Не разобрано счетов: ${notSet}. Проводки по ним загрузить нельзя.`
              : 'Все счета из файла разобраны.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm text-green-700">Сохранено</span>}
          <button
            onClick={onSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
            {saving ? 'Сохраняю…' : 'Сохранить счета'}
          </button>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-5 py-2 text-left font-medium">Счёт 1С</th>
            <th className="px-5 py-2 text-right font-medium">Проводок</th>
            <th className="px-5 py-2 text-left font-medium">Счёт FINDIR</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(a => {
            const v = value[a.account] ?? ''
            return (
              <tr key={a.account} className={`border-t border-gray-100 ${v ? '' : 'bg-red-50/40'}`}>
                <td className="px-5 py-2 font-semibold tracking-wide">{a.account}</td>
                <td className="px-5 py-2 text-right text-gray-500">{a.count}</td>
                <td className="px-5 py-2">
                  {a.hidden ? (
                    <span className="text-gray-500">счёт закрыт для вашей должности</span>
                  ) : (
                    <select
                      className={`${inputCls} w-full max-w-md`}
                      value={v}
                      onChange={e => onChange(a.account, e.target.value)}>
                      <option value="">— не разобрано —</option>
                      <option value="skip">— не переносить —</option>
                      {chart.map(b => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}
                    </select>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Аналитика двумя списками: что не переносится и что переносится.
 *
 * Разделение не косметическое — работать надо с первым списком, а второй нужен
 * лишь чтобы убедиться, что там всё правильно, и при случае перепривязать.
 */
function AnalyticsCard({ subconto, onOpen }) {
  if (!subconto.length) return null

  const bad  = subconto.filter(s => !s.info_id)
  const good = subconto.filter(s => s.info_id)

  const table = (list, title, hint) => list.length === 0 ? null : (
    <div>
      <div className="px-5 py-3 bg-gray-50 border-y border-gray-100">
        <div className="text-sm font-medium text-gray-800">{title} — {list.length}</div>
        <p className="text-xs text-gray-500">{hint}</p>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {list.map(s => (
            <tr key={s.key} className="border-b border-gray-50 last:border-0">
              <td className="px-5 py-2">
                <div className="text-gray-800">{s.name}</div>
                <div className="text-xs text-gray-400">
                  {s.kind}
                  {s.code && <span className="ml-2">код {s.code}</span>}
                  {s.inn && <span className="ml-2">ИНН {s.inn}</span>}
                </div>
              </td>
              <td className="px-3 py-2 text-right text-gray-500 whitespace-nowrap">{s.count}</td>
              <td className="px-3 py-2">
                {s.info_name ? (
                  <>
                    <div className="text-gray-800">{s.info_name}</div>
                    {SOURCE[s.source] && (
                      <div className={`text-xs ${SOURCE[s.source].cls}`}>{SOURCE[s.source].label}</div>
                    )}
                  </>
                ) : (
                  <div className="text-amber-800 text-xs">{s.reason || 'не переносится'}</div>
                )}
              </td>
              <td className="px-5 py-2 text-right whitespace-nowrap">
                <button onClick={() => onOpen(s.key)}
                  className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
                  {s.source === 'binding' ? 'Изменить' : 'Привязать'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-clip">
      <div className="px-5 py-4 border-b border-gray-100">
        <div className="text-sm font-medium text-gray-800">Аналитика</div>
        <p className="text-sm text-gray-500">
          Уникальные субконто файла. Правится один раз — привязка действует на все проводки с ним.
        </p>
      </div>

      {table(bad, 'Не переносится', 'Проводки загрузятся, но слот аналитики останется пустым')}
      {table(good, 'Переносится', 'Можно перепривязать, если подставилось не то')}
    </div>
  )
}

/** Итог загрузки. */
function ResultCard({ result }) {
  const warnings = result.warnings || []

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Field label="Создано" value={result.created} />
        <Field label="Обновлено" value={result.updated} />
        <Field label="Пропущено" value={result.skipped} />
        <Field label="Не удалось" value={result.failed} />
      </div>

      {warnings.length > 0 && (
        <ul className="mt-4 space-y-0.5 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  )
}

/** Таблица проводок: что получится из каждой и можно ли её взять. */
function PostingsCard({ rows, picked, onPick, onPickAll, onBind, stats }) {
  const pickable = rows.filter(r => STATUS[r.status]?.pick)
  const allOn    = pickable.length > 0 && pickable.every(r => picked[r.id])

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-clip">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2 flex-wrap">
        {ORDER.filter(s => stats[s] > 0).map(s => (
          <span key={s} className="flex items-center gap-1.5 text-sm text-gray-600">
            <Chip status={s} /> {stats[s]}
          </span>
        ))}
        <span className="text-xs text-gray-400 ml-auto">Щёлкните по аналитике, чтобы привязать её</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 w-8">
                <input type="checkbox" checked={allOn} onChange={e => onPickAll(e.target.checked)} />
              </th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Дата</th>
              <th className="px-3 py-2 text-left font-medium">Документ</th>
              <th className="px-3 py-2 text-left font-medium">Дебет</th>
              <th className="px-3 py-2 text-left font-medium">Кредит</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Сумма</th>
              <th className="px-3 py-2 text-left font-medium">Состояние</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const st = STATUS[r.status] || STATUS.new
              return (
                <tr key={r.id} className={`border-t border-gray-100 align-top ${st.pick ? '' : 'bg-gray-50/60'}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      disabled={!st.pick}
                      checked={!!picked[r.id]}
                      onChange={e => onPick(r.id, e.target.checked)} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtDate(r.date)}</td>
                  <td className="px-3 py-2 max-w-xs">
                    <div className="text-gray-800">{r.document || '—'}</div>
                    {r.content && <div className="text-gray-500 text-xs mt-0.5">{r.content}</div>}
                  </td>
                  <td className="px-3 py-2"><Side side={r.debit} onBind={onBind} /></td>
                  <td className="px-3 py-2"><Side side={r.credit} onBind={onBind} /></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{money(r.amount)}</td>
                  <td className="px-3 py-2">
                    <Chip status={r.status} />
                    {r.problem && <div className="text-xs text-gray-600 mt-1">{r.problem}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Одна сторона проводки со всей аналитикой.
 *
 * Непереносимое показывается всегда и заметно: раньше оно пряталось за
 * галочкой и серым зачёркиванием, а это ровно то, что человеку надо увидеть —
 * что именно из 1С не доехало в учёт. Щелчок по любой строке аналитики
 * открывает привязку.
 */
function Side({ side, onBind }) {
  return (
    <div className="min-w-[13rem]">
      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold tracking-wide text-gray-500">{side.account}</span>
        <span className="text-gray-400">→</span>
        <span className={side.bi ? 'text-gray-800' : 'text-red-700'}>
          {side.bi || (side.skipped ? 'не переносится' : 'не сопоставлен')}
        </span>
      </div>

      {side.quantity > 0 && (
        <div className="text-xs text-gray-500 mt-0.5">количество {money(side.quantity)}</div>
      )}

      {(side.analytics || []).map((a, i) => (
        <button key={i} type="button" onClick={() => onBind(a.key)}
          className={`block w-full text-left text-xs mt-1 rounded px-1.5 py-0.5 ${
            a.slot
              ? 'text-gray-700 hover:bg-gray-100'
              : 'bg-amber-50 ring-1 ring-amber-200 text-amber-900 hover:bg-amber-100'
          }`}>
          {a.slot ? (
            <>
              <span className="text-gray-400">{a.slot}:</span> {a.info_name}
              <span className="text-gray-400 ml-1">← {a.name}</span>
            </>
          ) : (
            <>
              {a.name}
              <span className="text-amber-700 ml-1">— {a.reason || 'не переносится'}</span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}
