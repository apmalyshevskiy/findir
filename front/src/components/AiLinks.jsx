import { useState } from 'react'
import { applyLinks } from '../api/ai'

/**
 * Предложенные ИИ связи «статья ДДС → статья расхода» (info.default_expense_id).
 * Применяются только по подтверждению пользователя.
 */
export default function AiLinks({ links, applied = [], disabled, onApplied }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const apply = async (list) => {
    setBusy(true); setError('')
    try {
      await applyLinks(list.map(l => ({ flow_id: l.flow_id, expense_id: l.expense_id })))
      onApplied(list)
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось проставить связи')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-xs font-medium text-violet-800">
          Связать статьи ДДС со статьями расходов{links.length > 1 ? ` (${links.length})` : ''}:
        </p>
        {links.length > 1 && (
          <button onClick={() => apply(links)} disabled={busy || disabled}
            className="px-3 py-1 bg-violet-600 text-white rounded-lg text-xs font-medium hover:bg-violet-700 disabled:opacity-40">
            {busy ? 'Применяю…' : 'Применить все'}
          </button>
        )}
      </div>

      {applied.length > 0 && (
        <p className="text-xs text-green-700 mb-2">✓ Проставлено связей: {applied.length}</p>
      )}

      <div className="max-h-64 overflow-y-auto space-y-1">
        {links.map((l, i) => (
          <div key={i} className="flex items-center justify-between gap-3 py-0.5">
            <span className="text-sm text-gray-800">
              {l.flow_name}
              <span className="text-gray-400 mx-1.5">→</span>
              <span className="text-gray-700">{l.expense_name}</span>
              {l.replaces && <span className="text-xs text-amber-600 ml-2">(заменит «{l.replaces}»)</span>}
            </span>
            <button onClick={() => apply([l])} disabled={busy || disabled}
              className="px-2.5 py-1 bg-violet-600 text-white rounded-lg text-xs font-medium hover:bg-violet-700 disabled:opacity-40">
              Применить
            </button>
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}
