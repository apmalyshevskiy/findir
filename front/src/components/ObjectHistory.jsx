import { useEffect, useState } from 'react'
import api from '../api/client'
import { SkeletonRows } from './Busy'
import { whenUtc } from '../utils/datetime'

/**
 * История правок объекта: кто, когда, откуда и что изменил.
 *
 * Не путать с «Движениями»: там строки, которые объект дал в отчёты, здесь —
 * что с самим объектом делали люди.
 *
 * Значения приходят с сервера уже словами — счёт назван кодом и наименованием,
 * аналитика именем, флаг «да/нет». В базе разница хранится сырой, потому что
 * журнал обязан быть записью факта; читаемым его делает показ.
 */

const PATH = {
  operation: 'operations',
  document:  'documents',
  info:      'info',
}

const ACTION_TONE = {
  created:  'bg-green-50 text-green-700 ring-green-200',
  updated:  'bg-blue-50 text-blue-700 ring-blue-200',
  deleted:  'bg-red-50 text-red-700 ring-red-200',
  restored: 'bg-violet-50 text-violet-700 ring-violet-200',
}

/**
 * Что стало со строкой документа.
 *
 * Разница по составу приезжает с сервера уже разобранной: какая строка
 * добавилась, какая ушла, что поменялось внутри оставшейся. Одного «2 строки →
 * 3 строки» мало — по нему не видно, что именно дописали.
 */
const LINE_TONE = {
  added:   { mark: '+', cls: 'text-green-700 bg-green-50 ring-green-200' },
  removed: { mark: '−', cls: 'text-red-700 bg-red-50 ring-red-200' },
  changed: { mark: '~', cls: 'text-blue-700 bg-blue-50 ring-blue-200' },
  moved:   { mark: '↕', cls: 'text-gray-600 bg-gray-50 ring-gray-200' },
}

const LINE_LABEL = {
  added: 'добавлена', removed: 'удалена', changed: 'изменена', moved: 'перемещена',
}

function DocumentLines({ lines }) {
  return (
    <div className="mt-1 space-y-1">
      {lines.map((l, i) => {
        const tone = LINE_TONE[l.kind] || LINE_TONE.changed

        return (
          <div key={i} className="text-xs">
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span className={`px-1 rounded ring-1 font-mono leading-4 ${tone.cls}`}>{tone.mark}</span>
              <span className="text-gray-500">
                {/* Номер до правки показываем, только если строка переехала */}
                Строка {l.was_n ? `${l.was_n} → ${l.n}` : l.n}
              </span>
              <span className="text-gray-800 font-medium">{l.title}</span>
              {l.kind !== 'changed' && <span className="text-gray-500">{l.summary}</span>}
              <span className="text-gray-400">· {LINE_LABEL[l.kind]}</span>
            </div>

            {l.changes.length > 0 && (
              <table className="ml-6 mt-0.5">
                <tbody>
                  {l.changes.map((c, j) => (
                    <tr key={j} className="align-top">
                      <td className="pr-3 py-0.5 text-gray-500 whitespace-nowrap">{c.label}</td>
                      <td className="pr-2 py-0.5 text-gray-400 line-through">{c.was}</td>
                      <td className="pr-2 py-0.5 text-gray-300">→</td>
                      <td className="py-0.5 text-gray-800 font-medium">{c.now}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function ObjectHistory({ entity, id, onRestored }) {
  const [rows, setRows]   = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy]   = useState(null)   // номер версии, которую возвращаем
  const [refused, setRefused] = useState(null)

  const load = () => api.get(`/${PATH[entity]}/${id}/history`)
    .then(r => setRows(r.data.data || []))
    .catch(() => setError('Не удалось получить историю'))

  useEffect(() => { load() }, [entity, id])

  /**
   * Возврат к версии.
   *
   * Спрашиваем подтверждение: это правка данных, а не просмотр. Отказ сервера
   * показываем списком причин — «нельзя» без объяснения не подсказывает, что
   * чинить.
   */
  const restore = (version) => {
    if (!window.confirm(confirmText(version))) return

    setBusy(version); setRefused(null)

    api.post(`/${PATH[entity]}/${id}/restore/${version}`)
      .then(() => load().then(() => onRestored?.()))
      .catch(e => setRefused({
        message:  e.response?.data?.message || 'Не удалось вернуть версию',
        problems: e.response?.data?.problems || [],
      }))
      .finally(() => setBusy(null))
  }

  /**
   * Подтверждение у документа особое: возврат его ещё и перепроводит, а это
   * пересоздаёт операции в учёте. Человек должен знать это заранее.
   */
  const confirmText = (version) => entity === 'document'
    ? `Вернуть документ к версии ${version}? Шапка и строки заменятся, проведённый документ будет перепроведён заново. Нынешнее состояние останется в истории.`
    : `Вернуть объект к версии ${version}? Нынешнее состояние останется в истории.`

  if (error)  return <div className="text-sm text-red-700">{error}</div>
  if (!rows)  return <SkeletonRows rows={3} height="h-10" />

  if (rows.length === 0) {
    return (
      <div className="text-sm text-gray-400 py-6 text-center">
        Правок не было. История ведётся с 14 сентября 2026 года — всё, что меняли раньше, в неё не попало
      </div>
    )
  }

  const latest = rows[0]?.version

  return (
    <div className="space-y-3">
      {refused && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
          <div className="font-medium">{refused.message}</div>
          {refused.problems.length > 0 && (
            <ul className="mt-1 list-disc pl-4 space-y-0.5">
              {refused.problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
        </div>
      )}

      {rows.map(r => {
        // Состав строк показываем разбором, а не строкой таблицы: у него свой
        // вид. Если разбирать нечего, он остаётся обычным «2 строки → 3 строки»
        const lines = r.changes.find(c => c.field === 'items' && c.lines?.length)
        const plain = r.changes.filter(c => c !== lines)

        return (
        <div key={r.version} className="border-l-2 border-gray-100 pl-3">
          <div className="flex items-baseline gap-2 flex-wrap text-xs">
            <span className={`px-1.5 py-0.5 rounded ring-1 font-medium ${ACTION_TONE[r.action] || ACTION_TONE.updated}`}>
              {r.action_label}
            </span>
            <span className="text-gray-700">{whenUtc(r.created_at)}</span>
            {/* Автора может не быть: правка из расписания или очереди */}
            <span className="text-gray-500">{r.user_name || 'система'}</span>
            {r.source !== 'manual' && <span className="text-gray-400">· {r.source_label}</span>}
            {r.restored_from && <span className="text-violet-600">· из версии {r.restored_from}</span>}

            {/* У самой свежей версии кнопки нет: это и есть нынешнее состояние */}
            {r.version !== latest && (
              <button type="button" onClick={() => restore(r.version)} disabled={busy !== null}
                className="text-blue-700 hover:underline disabled:opacity-50 ml-auto">
                {busy === r.version ? 'Возвращаю…' : 'Вернуть'}
              </button>
            )}
            <span className={`text-gray-300 ${r.version !== latest ? '' : 'ml-auto'}`}>в. {r.version}</span>
          </div>

          {plain.length > 0 && (
            <table className="mt-1.5 text-xs">
              <tbody>
                {plain.map((c, i) => (
                  <tr key={i} className="align-top">
                    <td className="pr-3 py-0.5 text-gray-500 whitespace-nowrap">{c.label}</td>
                    <td className="pr-2 py-0.5 text-gray-400 line-through">{c.was}</td>
                    <td className="pr-2 py-0.5 text-gray-300">→</td>
                    <td className="py-0.5 text-gray-800 font-medium">{c.now}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {lines && (
            <div className="mt-1.5">
              <div className="text-xs text-gray-500">
                {lines.label}: <span className="text-gray-400 line-through">{lines.was}</span>
                {' → '}<span className="text-gray-800">{lines.now}</span>
              </div>
              <DocumentLines lines={lines.lines} />
            </div>
          )}
        </div>
        )
      })}
    </div>
  )
}
