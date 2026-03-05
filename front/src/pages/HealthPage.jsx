import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { getHealth } from '../api/health'
import Layout from '../components/Layout'

export default function HealthPage() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadHealth = () => {
    setLoading(true)
    getHealth()
      .then(res => {
        setData(res.data)
      })
      .catch(err => {
        console.error('Health check failed:', err)
        if (err.response?.status === 401) navigate('/login')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    // Проверка авторизации, как в DashboardPage
    api.get('/me').catch(() => navigate('/login'))
    
    loadHealth()
    
    // Автообновление каждые 30 секунд
    const interval = setInterval(loadHealth, 30000)
    return () => clearInterval(interval)
  }, [])

  if (loading && !data) {
    return (
      <Layout>
        <div className="p-6 text-gray-400">Загрузка данных мониторинга...</div>
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Состояние системы</h1>
        <button 
          onClick={loadHealth}
          className="text-xs bg-white border border-gray-200 px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors shadow-sm"
        >
          {loading ? 'Обновление...' : 'Обновить вручную'}
        </button>
      </div>

      {/* Основные показатели (Карточки) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Статус системы</p>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${data?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'}`}></div>
            <p className={`text-2xl font-bold ${data?.status === 'ok' ? 'text-gray-800' : 'text-red-600'}`}>
              {data?.status === 'ok' ? 'В норме' : 'Ошибка'}
            </p>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">База данных (Latency)</p>
          <p className="text-2xl font-bold text-blue-600">
            {data?.checks?.mysql?.latency_ms ? `${data.checks.mysql.latency_ms} ms` : '—'}
          </p>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Свободно на диске</p>
          <p className="text-2xl font-bold text-gray-700">{data?.checks?.server?.disk_free || '—'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Детальные проверки */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
            <h2 className="font-semibold text-gray-800 text-sm uppercase">Сервисы</h2>
          </div>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-gray-50">
                <td className="px-6 py-4 text-gray-600 font-medium">MySQL Connection</td>
                <td className="px-6 py-4 text-right">
                  <span className={`px-2 py-1 rounded text-xs font-mono ${data?.checks?.mysql?.status === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                    {data?.checks?.mysql?.status?.toUpperCase() || 'ERROR'}
                  </span>
                </td>
              </tr>
              <tr className="border-b border-gray-50">
                <td className="px-6 py-4 text-gray-600 font-medium">Redis Cache</td>
                <td className="px-6 py-4 text-right">
                  <span className={`px-2 py-1 rounded text-xs font-mono ${data?.checks?.redis === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                    {data?.checks?.redis?.toUpperCase() || 'ERROR'}
                  </span>
                </td>
              </tr>
              <tr>
                <td className="px-6 py-4 text-gray-600 font-medium">Memory Usage (PHP)</td>
                <td className="px-6 py-4 text-right text-gray-500 font-mono">
                  {data?.checks?.server?.memory_usage}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Версии ПО */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
            <h2 className="font-semibold text-gray-800 text-sm uppercase">Окружение</h2>
          </div>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-gray-50">
                <td className="px-6 py-4 text-gray-600 font-medium">PHP Version</td>
                <td className="px-6 py-4 text-right font-mono text-gray-500">{data?.versions?.php}</td>
              </tr>
              <tr className="border-b border-gray-50">
                <td className="px-6 py-4 text-gray-600 font-medium">Laravel Framework</td>
                <td className="px-6 py-4 text-right font-mono text-gray-500">{data?.versions?.laravel}</td>
              </tr>
              <tr className="border-b border-gray-50">
                <td className="px-6 py-4 text-gray-600 font-medium">NPM</td>
                <td className="px-6 py-4 text-right font-mono text-gray-500">{data?.versions?.npm}</td>
              </tr>
              <tr>
                <td className="px-6 py-4 text-gray-600 font-medium">Tailwind CSS</td>
                <td className="px-6 py-4 text-right font-mono text-gray-500">{data?.versions?.tailwind}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6 text-center">
        <p className="text-xs text-gray-400">
          Данные актуальны на: {data?.timestamp ? new Date(data.timestamp).toLocaleString('ru-RU') : '—'}
        </p>
      </div>
    </Layout>
  )
}