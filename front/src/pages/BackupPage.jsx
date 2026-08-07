import { useEffect, useRef, useState } from 'react'
import Layout from '../components/Layout'
import { getBackupSummary, downloadBackup, inspectBackup, importBackup } from '../api/backup'

const TABLE_LABELS = {
  operations:                   'Операции',
  documents:                    'Документы',
  document_items:               'Строки документов',
  info:                         'Справочники',
  balance_items:                'План счетов',
  projects:                     'Проекты',
  settings:                     'Настройки',
  category_postings:            'Карта разноски',
  payment_classification_rules: 'Правила классификации',
  operation_templates:          'Шаблоны операций',
  budget_documents:             'Бюджеты',
  budget_items:                 'Строки бюджетов',
  budget_opening_balances:      'Входящие остатки бюджета',
  fund_schemes:                 'Модели распределения',
  funds:                        'Фонды',
  fund_plan_docs:               'Акты финансового планирования',
  fund_plan_lines:              'Строки актов',
  bulk_update_log:              'Журнал массовых правок',
  balance:                      'Остатки (устар.)',
}

const label = (t) => TABLE_LABELS[t] || t

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d) ? iso : d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Пустые таблицы в составе не показываем — они только удлиняют список
const meaningful = (counts) => Object.entries(counts || {})
  .filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1])

export default function BackupPage() {
  const [summary, setSummary] = useState(null)
  const [busy, setBusy]       = useState('')       // '' | 'export' | 'inspect' | 'import'
  const [error, setError]     = useState('')
  const [file, setFile]       = useState(null)
  const [preview, setPreview] = useState(null)
  const [result, setResult]   = useState(null)
  const fileRef = useRef(null)

  const tenant = (() => {
    try { return JSON.parse(localStorage.getItem('tenant') || '{}') } catch { return {} }
  })()

  const load = () => getBackupSummary().then(r => setSummary(r.data)).catch(() => setSummary(null))
  useEffect(() => { load() }, [])

  const handleExport = async () => {
    setBusy('export'); setError('')
    try {
      const r = await downloadBackup()
      // Имя файла сервер прислал в Content-Disposition
      const cd = r.headers['content-disposition'] || ''
      const m = /filename="?([^";]+)"?/.exec(cd)
      const name = m ? m[1] : `findir-${tenant.id || 'backup'}.json.gz`

      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/gzip' }))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError('Не удалось сформировать копию')
    } finally { setBusy('') }
  }

  const handlePick = async (f) => {
    setFile(f); setPreview(null); setResult(null); setError('')
    if (!f) return
    setBusy('inspect')
    try {
      const r = await inspectBackup(f)
      setPreview(r.data)
    } catch (e) {
      setError(e.response?.data?.message || 'Файл не подходит')
      setFile(null)
    } finally { setBusy('') }
  }

  const handleImport = async () => {
    const phrase = 'ЗАМЕНИТЬ'
    const typed = prompt(
      `Данные компании будут заменены содержимым файла. Текущие операции, документы и справочники будут удалены безвозвратно.\n\n` +
      `Для подтверждения введите ${phrase}:`
    )
    if (typed !== phrase) return

    setBusy('import'); setError('')
    try {
      const r = await importBackup(file)
      setResult(r.data)
      setPreview(null)
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      load()
    } catch (e) {
      setError(e.response?.data?.message || 'Не удалось восстановить')
    } finally { setBusy('') }
  }

  return (
    <Layout>
      <h2 className="text-xl font-semibold text-gray-800 mb-6">Архивная копия</h2>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">{error}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">

        {/* ── Выгрузка ─────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
          <h3 className="font-semibold text-gray-800">Выгрузить</h3>
          <p className="text-xs text-gray-500 mt-1">
            Один файл со всеми данными компании: операции, документы, справочники,
            план счетов, бюджеты и настройки.
          </p>

          {summary && (
            <div className="mt-4">
              <div className="text-xs text-gray-400 mb-1.5">В копию войдёт {summary.total} записей:</div>
              <div className="max-h-52 overflow-y-auto pr-1">
                <table className="w-full text-xs">
                  <tbody>
                    {meaningful(summary.counts).map(([t, n]) => (
                      <tr key={t} className="border-b border-gray-50 last:border-0">
                        <td className="py-1 text-gray-600">{label(t)}</td>
                        <td className="py-1 text-right text-gray-800 font-medium">{n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <button onClick={handleExport} disabled={busy === 'export'}
            className="mt-4 w-full px-4 py-2.5 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
            {busy === 'export' ? 'Формирую...' : '↓ Скачать копию'}
          </button>

          <p className="text-[11px] text-gray-400 mt-3">
            Пользователи и пароли в копию не входят — она про данные компании,
            а не про доступы.
          </p>
        </div>

        {/* ── Загрузка ─────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
          <h3 className="font-semibold text-gray-800">Восстановить</h3>
          <p className="text-xs text-gray-500 mt-1">
            Данные компании будут <span className="text-red-600 font-medium">заменены</span> содержимым
            файла. Сначала покажем, что внутри.
          </p>

          <input ref={fileRef} type="file" accept=".gz,.json,application/gzip,application/json"
            onChange={e => handlePick(e.target.files?.[0] || null)}
            className="mt-4 block w-full text-sm text-gray-600
                       file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0
                       file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700
                       hover:file:bg-gray-200" />

          {busy === 'inspect' && <div className="text-xs text-gray-400 mt-3">Читаю файл...</div>}

          {preview && (
            <div className="mt-4 border border-amber-200 bg-amber-50/60 rounded-lg p-3">
              <div className="text-xs text-gray-700">
                Копия компании <span className="font-semibold">{preview.tenant}</span> от {fmtDate(preview.created_at)}
              </div>

              {preview.tenant !== tenant.id && (
                <div className="text-xs text-red-700 mt-1.5">
                  ⚠ Файл от другой компании ({preview.tenant}), а вы работаете в «{tenant.id}».
                  Восстановление перенесёт чужие данные сюда.
                </div>
              )}

              <div className="max-h-40 overflow-y-auto mt-2 pr-1">
                <table className="w-full text-xs">
                  <tbody>
                    {meaningful(preview.counts).map(([t, n]) => (
                      <tr key={t} className="border-b border-amber-100/70 last:border-0">
                        <td className="py-1 text-gray-600">{label(t)}</td>
                        <td className="py-1 text-right text-gray-800 font-medium">{n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button onClick={handleImport} disabled={busy === 'import'}
                className="mt-3 w-full px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {busy === 'import' ? 'Восстанавливаю...' : 'Заменить данные из файла'}
              </button>
            </div>
          )}

          {result && (
            <div className="mt-4 border border-green-200 bg-green-50/60 rounded-lg p-3 text-xs text-gray-700">
              ✓ Восстановлено записей: <span className="font-semibold">{result.total}</span>
              {result.skipped?.length > 0 && (
                <div className="text-gray-500 mt-1">
                  Пропущены таблицы, которых нет в базе: {result.skipped.join(', ')}
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-gray-400 mt-3">
            Перед восстановлением сделайте свежую выгрузку — вернуть текущее
            состояние иначе будет нечем.
          </p>
        </div>
      </div>
    </Layout>
  )
}

