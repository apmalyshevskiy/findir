import { cva } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Кнопка — одна на всё приложение.
 *
 * Раньше «главная кнопка» была свёрстана по месту полутора десятками способов:
 * где-то blue-900, где-то blue-600, с разными отступами и разным видом в
 * выключенном состоянии. Человек не обязан знать, что это одна и та же кнопка,
 * — он видит разные и не понимает, какая из них главная.
 *
 * Варианты — по смыслу действия, а не по цвету:
 *   primary   — главное действие экрана, одно на область;
 *   secondary — рядовое действие;
 *   ghost     — действие в строке таблицы и в панели, где рамка шумит;
 *   danger    — удаление и всё, что нельзя вернуть;
 *   gold      — редкий акцент: один призыв на экран (например, на входе).
 */
// eslint-disable-next-line react-refresh/only-export-components
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:   'bg-brand-800 text-white shadow-sm hover:bg-brand-700 active:bg-brand-900',
        secondary: 'bg-white text-gray-700 border border-gray-200 shadow-sm hover:bg-gray-50 hover:border-gray-300',
        ghost:     'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
        danger:    'bg-red-600 text-white shadow-sm hover:bg-red-700',
        'danger-ghost': 'text-red-600 hover:bg-red-50',
        gold:      'bg-gold-500 text-brand-950 shadow-sm hover:bg-gold-400',
        link:      'text-brand-700 hover:text-brand-900 underline-offset-2 hover:underline',
      },
      size: {
        xs: 'h-7 px-2 text-xs rounded-md',
        sm: 'h-8 px-3 text-xs rounded-lg',
        md: 'h-9 px-4 text-sm rounded-lg',
        lg: 'h-11 px-5 text-sm rounded-xl',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export default function Button({
  variant, size, loading = false, icon, className, children, disabled, type = 'button', ...rest
}) {
  const Icon = icon
  return (
    <button type={type} disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {/* Пока запрос идёт, значок сменяется крутилкой, а ширина кнопки не
          прыгает: подпись остаётся на месте */}
      {loading
        ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        : Icon && <Icon className={size === 'xs' || size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} aria-hidden="true" />}
      {children}
    </button>
  )
}

/**
 * Кнопка-значок. Подпись обязательна: значок без слов понятен автору, а не
 * пользователю, и читалка экрана без неё объявит просто «кнопка».
 */
export function IconButton({ icon, label, variant = 'ghost', size = 'md', className, ...rest }) {
  const Icon = icon
  const box = { xs: 'w-6 h-6 rounded-md', sm: 'w-7 h-7 rounded-md', md: 'w-8 h-8 rounded-lg', lg: 'w-9 h-9 rounded-lg' }[size]
  const ico = { xs: 'w-3.5 h-3.5', sm: 'w-4 h-4', md: 'w-4 h-4', lg: 'w-5 h-5' }[size]
  const tone = {
    ghost:  'text-gray-400 hover:text-gray-700 hover:bg-gray-100',
    danger: 'text-gray-400 hover:text-red-600 hover:bg-red-50',
    brand:  'text-brand-700 hover:bg-brand-50',
    solid:  'bg-white border border-gray-200 text-gray-600 shadow-sm hover:bg-gray-50',
  }[variant]
  return (
    <button type="button" title={label} aria-label={label}
      className={cn('inline-flex items-center justify-center shrink-0 transition-colors disabled:opacity-40 disabled:pointer-events-none', box, tone, className)}
      {...rest}>
      <Icon className={ico} aria-hidden="true" />
    </button>
  )
}
