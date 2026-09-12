import { useId } from 'react'

/**
 * Знак FINDIR — «две записи».
 *
 * Два квадрата внахлёст: одна операция всегда имеет две стороны. Жёлтым горит
 * только место пересечения — там, где сумма проходит и по дебету, и по кредиту.
 *
 * `light` — версия для тёмного фона: фирменный синий на нём проваливается.
 *
 * Обрезка нужна, чтобы жёлтым стал ровно тот кусок контура, который попадает
 * на закрашенный квадрат. Идентификатор берём у React: знак выводится в
 * нескольких местах одной страницы, а одинаковые id в SVG склеиваются.
 */
export default function Logo({ size = 24, light = false, className = '' }) {
  const clipId = useId()

  const field = light ? '#93ACFF' : '#1E3A8A'
  const cross = light ? '#F5C45C' : '#E9A81E'

  return (
    <svg width={size} height={size} viewBox="3 3 27.4 27.4" className={className}
      role="img" aria-label="FINDIR">
      <clipPath id={clipId}>
        <rect x="4.5" y="4.5" width="16" height="16" rx="4.2" />
      </clipPath>

      <rect x="4.5" y="4.5" width="16" height="16" rx="4.2" fill={field} />
      <rect x="11.5" y="11.5" width="16" height="16" rx="4.2" fill="none" stroke={field} strokeWidth="2.8" />
      <g clipPath={`url(#${clipId})`}>
        <rect x="11.5" y="11.5" width="16" height="16" rx="4.2" fill="none" stroke={cross} strokeWidth="2.8" />
      </g>
    </svg>
  )
}
