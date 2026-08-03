import { useEffect, useState } from 'react'
import {
  getDictionaryTemplates,
  getDictionaryTemplate,
  applyDictionaryTemplate,
} from '../api/dictionaryTemplates'

const TYPE_LABELS = {
  partner:    'Контрагенты',
  product:    'Товары/Услуги',
  cash:       'Кассы/Счета',
  employee:   'Сотрудники',
  revenue:    'Статьи доходов',
  expenses:   'Статьи расходов',
  department: 'Отделы',
  flow:       'Статьи движения',
}

// Порядок групп в предпросмотре — как в разделе «Справочники»
const TYPE_ORDER = ['cash', 'flow', 'revenue', 'expenses', 'product', 'department', 'partner', 'employee']

/**
 * Выбор шаблона наполнения справочников.
 *
 * Новый тенант стартует с пустыми справочниками: набор статей зависит от
 * бизнес-модели. Здесь он выбирает готовый набор и видит его состав до того,
 * как что-то будет создано. Повторное применение безопасно — то, что уже есть,
 * помечается и не трогается.
 */
export default function DictionaryTemplatePicker({ onClose, onApplied }) {
  const [templates, setTemplates] = useState([])
  const [selected, setSelected]   = useState(null)
  const [preview, setPreview]     = useState(null)
  const [loading, setLoading]     = useState(true)
  const [applying, setApplying]   = useState(false)
  const [error, setError]         = useState('')
  const [done, setDone]           = useState(null)

  useEffect(() => {
    getDictionaryTemplates()
      .then(res => {
        const list = res.data.data || []
        setTemplates(list)
        if (list.length > 0) setSelected(list[0].key)
      })
      .catch(err => setError(err.response?.data?.message || 'Не удалось загрузить шаблоны'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!selected) return
    setPreview(null)
    getDictionaryTemplate(selected)
      .then(res => setPreview(res.data.data))
      .catch(() => setPreview(null))
  }, [selected])

  const handleApply = async () => {
    if (!selected) return
    setApplying(true)
    setError('')
    try {
      const res = await applyDictionaryTemplate(selected)
      setDone(res.data.result)
      if (onApplied) onApplied()
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка при заполнении')
    } finally {
      setApplying(false)
    }
  }

  // Элементы предпросмотра, сгруппированные по типу справочника
  const grouped = (() => {
    if (!preview) return []
    const byType = {}
    preview.items.forEach(item => {
      ;(byType[item.type] ||= []).push(item)
    })
    return TYPE_ORDER
      .filter(t => byType[t])
      .map(t => ({ type: t, label: TYPE_LABELS[t] || t, items: byType[t] }))
  })()

  // Отступ в дереве: глубина считается по цепочке parent внутри шаблона
  const depthOf = (item, all) => {
    let depth = 0
    let cur = item
    while (cur?.parent && depth < 10) {
      cur = all.find(i => i.key === cur.parent)
      if (!cur) break
      depth++
    }
    return depth
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Заполнить справочники</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Готовый набор статей. Всё можно править и дополнять после — записи, которые уже есть, не тронутся.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-gray-400">Загрузка...</div>
        ) : done ? (
          <div className="p-8 text-center">
            <div className="text-3xl mb-3">✓</div>
            <p className="text-gray-800 font-medium">
              {done.created > 0 ? `Добавлено записей: ${done.created}` : 'Всё уже было на месте'}
            </p>
            {done.skipped > 0 && (
              <p className="text-sm text-gray-400 mt-1">Пропущено как существующие: {done.skipped}</p>
            )}
            <button onClick={onClose}
              className="mt-6 px-5 py-2.5 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
              Готово
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col sm:flex-row">
            {/* Список шаблонов */}
            <div className="sm:w-64 border-b sm:border-b-0 sm:border-r border-gray-100 p-3 space-y-2 overflow-y-auto flex-shrink-0">
              {templates.map(t => (
                <button
                  key={t.key}
                  onClick={() => setSelected(t.key)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                    selected === t.key
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="text-sm font-medium text-gray-800">{t.name}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{t.total} записей</div>
                </button>
              ))}
              {templates.length === 0 && (
                <div className="text-sm text-gray-400 px-3 py-2">Шаблонов нет</div>
              )}
            </div>

            {/* Предпросмотр состава */}
            <div className="flex-1 overflow-y-auto p-5">
              {!preview ? (
                <div className="text-gray-400 text-sm">Загрузка состава...</div>
              ) : (
                <>
                  <p className="text-sm text-gray-600 mb-4">{preview.description}</p>
                  <div className="text-xs text-gray-400 mb-4">
                    Будет создано: <span className="font-medium text-gray-700">{preview.new}</span> из {preview.total}
                    {preview.total !== preview.new && ' — остальное уже есть'}
                  </div>

                  {grouped.map(group => (
                    <div key={group.type} className="mb-4">
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                        {group.label}
                      </div>
                      <div className="space-y-0.5">
                        {group.items.map((item, i) => (
                          <div key={`${item.type}-${item.code || item.name}-${i}`}
                            className="flex items-center justify-between text-sm py-0.5">
                            <span
                              className={item.exists ? 'text-gray-400' : 'text-gray-800'}
                              style={{ paddingLeft: depthOf(item, preview.items) * 16 }}
                            >
                              {depthOf(item, preview.items) > 0 && <span className="text-gray-300 mr-1.5">└</span>}
                              {item.name}
                            </span>
                            {item.exists && (
                              <span className="text-[10px] text-gray-400 whitespace-nowrap ml-2">уже есть</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {!done && !loading && (
          <div className="p-5 border-t border-gray-100">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-lg text-sm mb-3">
                {error}
              </div>
            )}
            <div className="flex gap-3">
              <button type="button" onClick={onClose}
                className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
                Отмена
              </button>
              <button type="button" onClick={handleApply} disabled={applying || !preview || preview.new === 0}
                className="flex-1 px-4 py-2.5 bg-blue-900 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50 text-sm font-medium">
                {applying ? 'Заполняю...' : preview?.new === 0 ? 'Нечего добавлять' : `Заполнить (${preview?.new ?? 0})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
