import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import AiQuickEntry from '../components/AiQuickEntry'
import OperationForm from '../components/OperationForm'
import { createTemplate } from '../api/operationTemplates'

/**
 * AI-помощник.
 *
 * Раньше жил панелью над списком операций и занимал там место у всех, включая
 * тех, кто вводит руками. Диалогу с ИИ нужен свой экран: он длинный, в нём
 * появляются черновики, показатели и предложения по справочникам, а список
 * операций под ним только мешал.
 *
 * Черновик открывается в обычной форме операции: помощник ничего не сохраняет
 * молча — человек видит проводку целиком и подтверждает её сам.
 */
export default function AiAssistantPage() {
  const navigate = useNavigate()
  const [draft, setDraft]       = useState(null)
  const [resetKey, setResetKey] = useState(0)
  const [saved, setSaved]       = useState(0)   // сколько операций создано за сеанс

  const saveTemplate = async (payload, defaultName) => {
    const name = prompt('Название шаблона (короткая фраза для кнопки):', defaultName || '')
    if (!name || !name.trim()) return
    try {
      await createTemplate(name.trim(), payload)
    } catch (err) {
      alert(err.response?.data?.message || 'Не удалось сохранить шаблон')
    }
  }

  return (
    <Layout>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI-помощник</h1>
          <p className="text-sm text-gray-500 mt-1">
            Опишите операцию словами, продиктуйте голосом или приложите чек, счёт и выписку.
            Помощник разберёт, посчитает показатели и подготовит проводку — записывать её будете вы.
          </p>
        </div>
        {saved > 0 && (
          <button onClick={() => navigate('/operations')}
            className="px-4 py-2 border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50">
            Создано операций: {saved} — открыть список →
          </button>
        )}
      </div>

      <AiQuickEntry
        onUseDraft={setDraft}
        onSaveTemplate={saveTemplate}
        // Массовые правки и создание справочников помощник делает сам —
        // списка на этой странице нет, обновлять нечего
        onChanged={() => {}}
        resetKey={resetKey}
      />

      {draft && (
        <OperationForm
          initial={draft}
          onSuccess={() => {
            setDraft(null)
            setSaved(n => n + 1)
            // Диалог начинаем заново: операция записана, продолжать уточнять
            // уже нечего
            setResetKey(k => k + 1)
          }}
          onCancel={() => setDraft(null)}
        />
      )}
    </Layout>
  )
}
