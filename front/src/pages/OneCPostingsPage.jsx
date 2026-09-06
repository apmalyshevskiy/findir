import { useEffect, useMemo, useRef, useState } from 'react'
import Layout from '../components/Layout'
import { getBalanceItemsList } from '../api/balanceItems'
import {
  getOneCSettings, saveOneCSettings, previewOneCPostings, importOneCPostings,
} from '../api/onec'

/**
 * Загрузка проводок из 1С:Бухгалтерии.
 *
 * Порядок шагов на странице повторяет порядок работы: файл → соответствие
 * счетов → проводки → загрузка. Соответствие стоит вторым не для красоты:
 * пока счёт 1С не переведён в наш план счетов, проводку взять не из чего, и
 * показывать её к загрузке было бы обманом.
 *
 * Сопоставление счетов сохраняется. В следующем месяце этот шаг проходится
 * молча — он оживает только когда в файле появился незнакомый счёт.
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

export default function OneCPostingsPage() {
  const fileInput = useRef(null)

  const [file, setFile]       = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState('')
  const [result, setResult]   = useState(null)

  const [accounts, setAccounts]   = useState([])
  const [projects, setProjects]   = useState([])
  const [projectId, setProjectId] = useState('')
  const [map, setMap]             = useState({})
  const [savingMap, setSavingMap] = useState(false)
  const [mapSaved, setMapSaved]   = useState(false)

  const [picked, setPicked]   = useState({})
  const [showDrop, setShowDrop] = useState(false)

  useEffect(() => {
    getBalanceItemsList().then(r => setAccounts(r.data.data || r.data || [])).catch(() => {})
    getOneCSettings()
      .then(r => {
        const d = r.data.data || {}
        setProjects(d.projects || [])
        setProjectId(d.project_id ? String(d.project_id) : '')
      })
      .catch(() => {})
  }, [])

  const run = (f) => {
    setBusy(true); setError(''); setResult(null)

    previewOneCPostings(f)
      .then(r => {
        const d = r.data.data
        setPreview(d)

        // Соответствие подтягиваем из ответа: там уже учтено и сохранённое
        // ранее, и то, чего в карте ещё нет
        const next = {}
        ;(d.accounts || []).forEach(a => { next[a.account] = a.bi_id ? String(a.bi_id) : '' })
        setMap(next)
        setMapSaved(false)

        const pick = {}
        ;(d.rows || []).forEach(row => { if (STATUS[row.status]?.auto) pick[row.id] = true })
        setPicked(pick)
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

  const saveMap = () => {
    setSavingMap(true); setError('')

    saveOneCSettings({
      project_id: projectId ? Number(projectId) : null,
      accounts: Object.entries(map).map(([account, bi_id]) => ({ account, bi_id: bi_id ? Number(bi_id) : null })),
    })
      .then(() => { setMapSaved(true); if (file) run(file) })
      .catch(e => setError(e.response?.data?.message || 'Не удалось сохранить соответствие'))
      .finally(() => setSavingMap(false))
  }

  const rows = preview?.rows || []

  const selected = useMemo(
    () => rows.filter(r => picked[r.id] && STATUS[r.status]?.pick),
    [rows, picked],
  )

  const load = () => {
    if (!selected.length) return
    setBusy(true); setError(''); setResult(null)

    importOneCPostings(file, selected.map(r => r.id))
      .then(r => { setResult(r.data.data); run(file) })
      .catch(e => setError(e.response?.data?.message || 'Не удалось загрузить проводки'))
      .finally(() => setBusy(false))
  }

  const unmapped = (preview?.accounts || []).filter(a => !a.bi_id)
  const stats    = preview?.stats || {}

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <h2 className="text-xl font-semibold text-gray-800">Проводки из 1С</h2>
        {preview && (
          <button
            onClick={() => fileInput.current?.click()}
            className="text-sm text-blue-700 hover:underline">
            Выбрать другой файл
          </button>
        )}
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

          <ProjectCard
            projects={projects}
            value={projectId}
            onChange={setProjectId}
            onSave={saveMap}
            saving={savingMap}
          />

          <AccountsCard
            accounts={preview.accounts}
            chart={accounts}
            map={map}
            onChange={(account, biId) => { setMap(p => ({ ...p, [account]: biId })); setMapSaved(false) }}
            onSave={saveMap}
            saving={savingMap}
            saved={mapSaved}
            unmapped={unmapped.length}
          />

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
            showDrop={showDrop}
            onShowDrop={setShowDrop}
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
        </div>
      )}
    </Layout>
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

const Field = ({ label, value }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
    <div className="text-gray-800 font-medium">{value ?? '—'}</div>
  </div>
)

/**
 * Проект выбирается у нас: в проводке 1С его нет и взяться ему неоткуда.
 * Хранится вместе с соответствием счетов — спрашивать каждый месяц незачем.
 */
function ProjectCard({ projects, value, onChange, onSave, saving }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-gray-800 mb-1">Проект</div>
          <select className={inputCls} value={value} onChange={e => onChange(e.target.value)}>
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
function AccountsCard({ accounts, chart, map, onChange, onSave, saving, saved, unmapped }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-clip">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-gray-800">Соответствие счетов</div>
          <p className="text-sm text-gray-500">
            {unmapped > 0
              ? `Не сопоставлено счетов: ${unmapped}. Проводки по ним загрузить нельзя.`
              : 'Все счета из файла сопоставлены.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm text-green-700">Сохранено</span>}
          <button
            onClick={onSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
            {saving ? 'Сохраняю…' : 'Сохранить соответствие'}
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
          {accounts.map(a => (
            <tr key={a.account} className={`border-t border-gray-100 ${a.bi_id ? '' : 'bg-red-50/40'}`}>
              <td className="px-5 py-2 font-semibold tracking-wide">{a.account}</td>
              <td className="px-5 py-2 text-right text-gray-500">{a.count}</td>
              <td className="px-5 py-2">
                {a.hidden ? (
                  <span className="text-gray-500">счёт закрыт для вашей должности</span>
                ) : (
                  <select
                    className={`${inputCls} w-full max-w-md`}
                    value={map[a.account] ?? ''}
                    onChange={e => onChange(a.account, e.target.value)}>
                    <option value="">— не переносить —</option>
                    {chart.map(b => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
function PostingsCard({ rows, picked, onPick, onPickAll, showDrop, onShowDrop, stats }) {
  const pickable = rows.filter(r => STATUS[r.status]?.pick)
  const allOn    = pickable.length > 0 && pickable.every(r => picked[r.id])

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-clip">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {ORDER.filter(s => stats[s] > 0).map(s => (
            <span key={s} className="flex items-center gap-1.5 text-sm text-gray-600">
              <Chip status={s} /> {stats[s]}
            </span>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={showDrop} onChange={e => onShowDrop(e.target.checked)} />
          Показывать непереносимую аналитику
        </label>
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
                  <td className="px-3 py-2"><Side side={r.debit} showDrop={showDrop} /></td>
                  <td className="px-3 py-2"><Side side={r.credit} showDrop={showDrop} /></td>
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
 * Одна сторона проводки.
 *
 * Аналитика, которой в FINDIR нет, по умолчанию не показывается: в типовой
 * проводке 1С её больше, чем переносимой, — договоры, документы-регистраторы,
 * ставки НДС. Она не теряется молча, её видно по галочке над таблицей.
 */
function Side({ side, showDrop }) {
  return (
    <div className="min-w-[12rem]">
      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold tracking-wide text-gray-500">{side.account}</span>
        <span className="text-gray-400">→</span>
        <span className={side.bi ? 'text-gray-800' : 'text-red-700'}>{side.bi || 'не сопоставлен'}</span>
      </div>

      {side.quantity > 0 && (
        <div className="text-xs text-gray-500 mt-0.5">количество {money(side.quantity)}</div>
      )}

      {side.matched?.map((m, i) => (
        <div key={i} className="text-xs text-gray-700 mt-0.5">
          <span className="text-gray-400">{m.slot}:</span> {m.name}
        </div>
      ))}

      {showDrop && side.skipped?.map((s, i) => (
        <div key={i} className="text-xs text-gray-400 mt-0.5 line-through">{s}</div>
      ))}
    </div>
  )
}
