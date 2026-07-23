import { useState, useEffect } from 'react'
import { getEditLockDate, updateEditLockDate } from '../api/settings'
import Layout from '../components/Layout'

const formatDateShort = (iso) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

export default function EditLockDatePage() {
  const [date, setDate] = useState('')      // текущее значение поля
  const [saved, setSaved] = useState(null)  // сохранённая на сервере дата
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await getEditLockDate()
      setSaved(res.data.date || null)
      setDate(res.data.date || '')
    } catch (e) {
      setError('Не удалось загрузить настройку')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const save = async (value) => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await updateEditLockDate(value)
      setSaved(res.data.date || null)
      setDate(res.data.date || '')
      setNotice(res.data.date ? 'Дата запрета сохранена' : 'Запрет снят')
    } catch (e) {
      setError(e?.response?.data?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Layout>
      <div className="max-w-2xl mx-auto py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Дата запрета редактирования</h1>
          <p className="text-sm text-gray-500 mt-1">
            Закрытый период. Операции и документы с датой <b>по эту дату включительно</b>
            {' '}нельзя создавать, изменять, удалять и проводить. Данные после этой даты — как обычно.
          </p>
        </div>

        {error &&  <div className="bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}
        {notice && <div className="bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3">{notice}</div>}

        <div className="bg-white rounded-xl shadow-sm p-6 space-y-5">
          {loading ? (
            <div className="text-sm text-gray-500 py-4">Загрузка…</div>
          ) : (
            <>
              <div className="text-sm">
                <span className="text-gray-500">Текущий запрет: </span>
                {saved
                  ? <span className="font-semibold text-gray-900">по {formatDateShort(saved)} включительно</span>
                  : <span className="text-gray-400">не установлен</span>}
              </div>

              <div className="flex items-end gap-3 flex-wrap">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 font-medium">Запретить редактирование по дату</label>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <button
                  onClick={() => save(date)}
                  disabled={saving || !date || date === (saved || '')}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40"
                >
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
                {saved && (
                  <button
                    onClick={() => save('')}
                    disabled={saving}
                    className="px-4 py-2 text-red-600 text-sm hover:text-red-700 disabled:opacity-40"
                  >
                    Снять запрет
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  )
}
