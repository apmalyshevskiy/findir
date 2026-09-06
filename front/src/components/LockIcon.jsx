/**
 * Замок — там, где счёт или раздел закрыт должностью.
 *
 * Рисуем svg, а не знак 🔒: эмодзи система подменяет глифом из цветного
 * шрифта, он рисует себя сам и заданный цвет игнорирует. В строгой финансовой
 * таблице жёлтый пузырёк смотрелся игрушкой.
 *
 * Цвет берётся у текста (currentColor), размер — классом.
 */
export default function LockIcon({ className = 'w-3.5 h-3.5' }) {
  return (
    <svg className={`inline-block shrink-0 ${className}`} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
