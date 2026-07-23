import RevenueChart from '../RevenueChart'

// props:
//   series   — ответ /dashboard/revenue-series за итоговый диапазон виджета
//   colorMap — цвет по id проекта
export default function ChartWidget({ series, colorMap }) {
  if (!series) {
    return <div className="p-5 text-sm text-gray-400">Загрузка…</div>
  }
  return (
    <div className="p-4">
      <RevenueChart days={series.days} projects={series.projects} series={series.series} colorMap={colorMap} />
    </div>
  )
}
