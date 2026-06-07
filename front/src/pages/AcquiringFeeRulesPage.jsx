import { useState, useEffect } from 'react'
import { getAcquiringFeeRules, updateAcquiringFeeRules } from '../api/settings'
import Layout from '../components/Layout'

const ic = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

// Банки, которые умеет скоупить парсер (detectBank по «Отправитель»).
// Новый банк → сначала добавить ветку в detectBank на бэке, потом сюда.
const BANKS = [
  { value: 'tbank', label: 'Т-Банк' },
  { value: 'alfa',  label: 'Альфа-Банк' },
  { value: 'sber',  label: 'Сбербанк' },
]
const BANK_LABEL = Object.fromEntries(BANKS.map(b => [b.value, b.label]))

// Человекочитаемые подписи форматов суммы (значения приходят из API: formats).
const FORMAT_LABEL = {
  rub_kop: 'Рубли/копейки словами — «2534 руб. 77 коп.»',
  dot:     'Через точку — «1525.34», «1 511.16»',
}

const emptyRule = { bank: 'tbank', marker: '', amount_format: 'dot', is_active: true }

export default function AcquiringFeeRulesPage() {
  const [rules, setRules] = useState([])
  const [formats, setFormats] = useState([])
  const [defaults, setDefaults] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await getAcquiringFeeRules()
      setRules(res.data.data || [])
      setFormats(res.data.formats || ['rub_kop', 'dot'])
      setDefaults(res.data.defaults || [])
    } catch (e) {
      setError('Не удалось загрузить правила')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const setRow = (i, patch) =>
    setRules(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  const addRow = () => setRules(rs => [...rs, { ...emptyRule }])
  const removeRow = (i) => setRules(rs => rs.filter((_, idx) => idx !== i))
  const resetToDefaults = () => {
    setRules(defaults.map(r => ({ ...r })))
    setNotice('Загружены значения по умолчанию — нажмите «Сохранить», чтобы применить')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await updateAcquiringFeeRules(rules)
      setRules(res.data.data || [])
      setNotice('Сохранено')
    } catch (e) {
      // Бэкенд возвращает понятный текст ошибки валидации (422).
      setError(e?.response?.data?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  const canSave = rules.every(r => (r.marker || '').trim() !== '')

  return (
    <Layout>
      <div className="max-w-6xl mx-auto py-6 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Эквайринг — выделение комиссии</h1>
          <p className="text-sm text-gray-500 mt-1">
            Правила «свода»: когда банк зачисляет выручку за вычетом комиссии, а сумму комиссии
            пишет только в назначении. При загрузке выписки такая строка автоматически разворачивается
            в две операции — приход нетто и комиссию.
          </p>
        </div>

        {error &&  <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}
        {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3">{notice}</div>}

        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Правила по банкам</h2>
            <div className="flex gap-2">
              <button onClick={resetToDefaults} className="px-4 py-2 text-gray-600 text-sm hover:text-gray-900">
                Сбросить к умолчаниям
              </button>
              <button onClick={addRow} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                + Правило
              </button>
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-gray-500 py-8 text-center">Загрузка…</div>
          ) : rules.length === 0 ? (
            <div className="text-sm text-gray-500 py-8 text-center">
              Правил нет. Нажмите «Сбросить к умолчаниям», чтобы добавить базовый набор.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="pb-2 pr-3 font-medium">Банк</th>
                  <th className="pb-2 pr-3 font-medium">Маркер в назначении</th>
                  <th className="pb-2 pr-3 font-medium">Формат суммы</th>
                  <th className="pb-2 pr-3 font-medium text-center">Вкл.</th>
                  <th className="pb-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr key={i} className="border-b border-gray-50 align-top">
                    <td className="py-2 pr-3 w-40">
                      <select className={ic} value={r.bank || ''} onChange={e => setRow(i, { bank: e.target.value })}>
                        {BANKS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
                        {/* на случай неизвестного банка из БД — показать как есть */}
                        {r.bank && !BANK_LABEL[r.bank] && <option value={r.bank}>{r.bank}</option>}
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        className={ic}
                        value={r.marker || ''}
                        placeholder="например: Комиссия"
                        onChange={e => setRow(i, { marker: e.target.value })}
                      />
                      <div className="text-xs text-gray-400 mt-1">сумма берётся сразу после этого текста</div>
                    </td>
                    <td className="py-2 pr-3 w-72">
                      <select className={ic} value={r.amount_format || ''} onChange={e => setRow(i, { amount_format: e.target.value })}>
                        {formats.map(f => <option key={f} value={f}>{FORMAT_LABEL[f] || f}</option>)}
                      </select>
                    </td>
                    <td className="py-2 pr-3 text-center">
                      <input
                        type="checkbox"
                        checked={!!r.is_active}
                        onChange={e => setRow(i, { is_active: e.target.checked })}
                      />
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => removeRow(i)} className="text-gray-400 hover:text-red-600 text-sm" title="Удалить">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex justify-end gap-2 pt-6">
            <button onClick={load} className="px-4 py-2 text-gray-600 text-sm">Отмена</button>
            <button
              onClick={save}
              disabled={saving || !canSave}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40"
            >
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </Layout>
  )
}
