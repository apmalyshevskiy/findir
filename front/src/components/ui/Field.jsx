import { cn } from '../../lib/utils'

/**
 * Поля ввода. Строка классов поля была скопирована в двадцать с лишним файлов
 * константой `ic`/`sc`/`inputCls` — и разошлась: где-то кольцо фокуса в два
 * пикселя, где-то в один, где-то скругление другое. Теперь стиль один.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const fieldClass = (size = 'md', invalid = false) => cn(
  'w-full bg-white border text-gray-900 placeholder:text-gray-400 transition-[border-color,box-shadow] duration-150',
  'focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500',
  'disabled:bg-gray-50 disabled:text-gray-500',
  size === 'sm' ? 'h-8 px-2.5 text-xs rounded-lg' : 'h-9 px-3 text-sm rounded-lg',
  invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20' : 'border-gray-200 hover:border-gray-300',
)

export function Input({ size, invalid, className, ...rest }) {
  return <input className={cn(fieldClass(size, invalid), className)} {...rest} />
}

export function Select({ size, invalid, className, children, ...rest }) {
  return <select className={cn(fieldClass(size, invalid), 'pr-8', className)} {...rest}>{children}</select>
}

export function Textarea({ invalid, className, ...rest }) {
  return <textarea className={cn(fieldClass('md', invalid), 'h-auto py-2 leading-5', className)} {...rest} />
}

/** Подпись, поле и строка под ним: подсказка или ошибка */
export default function Field({ label, hint, error, required, className, children }) {
  return (
    <label className={cn('block', className)}>
      {label && (
        <span className="block mb-1 text-xs font-medium text-gray-600">
          {label}{required && <span className="text-red-500"> *</span>}
        </span>
      )}
      {children}
      {error
        ? <span className="block mt-1 text-xs text-red-600">{error}</span>
        : hint && <span className="block mt-1 text-xs text-gray-500">{hint}</span>}
    </label>
  )
}
