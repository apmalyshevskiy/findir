import { AlertTriangle, RotateCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import Button from './Button'

/**
 * Шапка страницы: что это за экран и что на нём можно сделать.
 *
 * У страниц было пять разных заголовков (h1 и h2, 20 и 24 пикселя, жирный и
 * полужирный), а у бюджета и операций не было никакого. Переходя из раздела в
 * раздел, человек каждый раз заново искал глазами, где он.
 */
export function PageHeader({ title, subtitle, actions, children, className }) {
  return (
    <header className={cn('mb-5', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[1.375rem] leading-7 font-semibold tracking-tight text-gray-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4 flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  )
}

/** Карточка — белая плоскость на странице */
export function Card({ className, children, ...rest }) {
  return (
    <div className={cn('bg-white rounded-xl border border-gray-200/80 shadow-card', className)} {...rest}>
      {children}
    </div>
  )
}

/** Пусто — и что с этим делать */
export function EmptyState({ icon: Icon, title, text, action, className }) {
  return (
    <div className={cn('flex flex-col items-center text-center px-6 py-14', className)}>
      {Icon && (
        <div className="w-12 h-12 mb-4 rounded-2xl bg-gray-100 text-gray-400 flex items-center justify-center">
          <Icon className="w-6 h-6" aria-hidden="true" />
        </div>
      )}
      <div className="text-sm font-medium text-gray-800">{title}</div>
      {text && <p className="mt-1 max-w-sm text-sm text-gray-500">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/**
 * Данные не загрузились.
 *
 * Отдельное состояние, а не пустой список: раньше оборванный запрос показывал
 * «Нет операций за период» — и финансист делал вывод по цифрам, которых просто
 * не дождался. «Не загрузилось» и «ничего нет» обязаны выглядеть по-разному.
 */
export function ErrorState({ title = 'Не удалось загрузить данные', text, onRetry, className }) {
  return (
    <div role="alert" className={cn('flex flex-col items-center text-center px-6 py-14', className)}>
      <div className="w-12 h-12 mb-4 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center">
        <AlertTriangle className="w-6 h-6" aria-hidden="true" />
      </div>
      <div className="text-sm font-medium text-gray-800">{title}</div>
      <p className="mt-1 max-w-sm text-sm text-gray-500">
        {text || 'Это не значит, что данных нет: запрос не дошёл или сервер ответил ошибкой.'}
      </p>
      {onRetry && <Button className="mt-4" icon={RotateCw} onClick={onRetry}>Повторить</Button>}
    </div>
  )
}

const BADGE = {
  gray:   'bg-gray-100 text-gray-600',
  brand:  'bg-brand-50 text-brand-700',
  green:  'bg-emerald-50 text-emerald-700',
  amber:  'bg-amber-50 text-amber-800',
  red:    'bg-red-50 text-red-700',
  gold:   'bg-gold-100 text-gold-800',
}

export function Badge({ tone = 'gray', className, children }) {
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', BADGE[tone], className)}>
      {children}
    </span>
  )
}

/**
 * Переключатель «одно из нескольких»: План / Факт / П+Ф.
 * Выбранное лежит белой плашкой на серой подложке — видно и что выбрано, и что
 * это один элемент управления, а не три отдельные кнопки.
 */
export function Segmented({ value, onChange, options, size = 'md', className }) {
  return (
    <div role="radiogroup" className={cn('inline-flex p-0.5 bg-gray-100 rounded-lg', className)}>
      {options.map(o => {
        const on = o.value === value
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={on} title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 font-medium rounded-md transition-colors whitespace-nowrap',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-xs',
              on ? 'bg-white text-brand-800 shadow-sm' : 'text-gray-500 hover:text-gray-800',
            )}>
            {o.icon && <o.icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Кнопка-флажок в панели: включено / выключено */
export function Toggle({ pressed, onChange, icon: Icon, children, title, className }) {
  return (
    <button type="button" aria-pressed={pressed} title={title} onClick={() => onChange(!pressed)}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap',
        pressed
          ? 'bg-brand-50 border-brand-200 text-brand-800'
          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-900',
        className,
      )}>
      {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
      {children}
    </button>
  )
}

/** Вкладки с подчёркиванием */
export function Tabs({ value, onChange, tabs, className }) {
  return (
    <div role="tablist" className={cn('flex gap-1 border-b border-gray-200 overflow-x-auto', className)}>
      {tabs.map(t => {
        const on = t.value === value
        return (
          <button key={String(t.value)} type="button" role="tab" aria-selected={on}
            onClick={() => onChange(t.value)}
            className={cn(
              'relative px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              on ? 'text-brand-800' : 'text-gray-500 hover:text-gray-800',
            )}>
            {t.label}
            {t.count != null && <span className="ml-1.5 text-xs text-gray-400 tabular-nums">{t.count}</span>}
            {on && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gold-500" />}
          </button>
        )
      })}
    </div>
  )
}
