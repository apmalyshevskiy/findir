import { useState } from 'react'
import { ArrowLeftRight, Eye, EyeOff, Table2, Target } from 'lucide-react'
import Logo from './Logo'
import { fieldClass } from './ui'
import { cn } from '../lib/utils'

/**
 * Экран входа и регистрации: форма слева, панель бренда справа.
 *
 * Раньше это была одинокая карточка посреди серого поля — первый экран
 * продукта ничем не отличался от страницы настроек. Здесь человек принимает
 * решение, доверять ли программе свои деньги, и экран должен выглядеть так,
 * будто над ним думали.
 *
 * На узком экране панель бренда убирается: форма важнее, а места на обе нет.
 */
const POINTS = [
  { icon: ArrowLeftRight, title: 'Учёт без бухгалтерского языка', text: 'Операции, документы и выписка из банка — в одном журнале' },
  { icon: Table2,         title: 'Отчёты, которые сходятся',     text: 'Оборотка, баланс и движение денег считаются из одних проводок' },
  { icon: Target,         title: 'План рядом с фактом',          text: 'Бюджет доходов и расходов, платёжный календарь, фонды' },
]

export default function AuthShell({ title, subtitle, footer, children }) {
  return (
    <div className="min-h-screen bg-white lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col min-h-screen lg:min-h-0 px-6 py-8 sm:px-10">
        <div className="flex items-center gap-2.5">
          <Logo size={28} />
          <span className="text-xl font-semibold tracking-[0.12em] text-brand-800">FINDIR</span>
        </div>

        <div className="flex-1 flex items-center justify-center py-10">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>}
            <div className="mt-7">{children}</div>
            {footer && <div className="mt-6 text-sm text-gray-500">{footer}</div>}
          </div>
        </div>

        <p className="text-xs text-gray-400">Финансовый директор для малого бизнеса</p>
      </div>

      <aside className="hidden lg:flex relative overflow-hidden bg-brand-950 text-white flex-col justify-center px-14 xl:px-20">
        {/* Знак логотипа во всю панель: два квадрата внахлёст — две стороны
            одной операции. Тот же мотив, что в углу, только крупно и тихо */}
        <svg className="absolute -right-24 -top-24 w-[36rem] h-[36rem] opacity-[0.07]" viewBox="3 3 27.4 27.4" aria-hidden="true">
          <rect x="4.5" y="4.5" width="16" height="16" rx="4.2" fill="#fff" />
          <rect x="11.5" y="11.5" width="16" height="16" rx="4.2" fill="none" stroke="#fff" strokeWidth="2.8" />
        </svg>
        <div className="absolute left-0 bottom-0 w-full h-1/2 bg-gradient-to-t from-brand-900/60 to-transparent" aria-hidden="true" />

        <div className="relative max-w-md">
          <div className="w-10 h-1 rounded-full bg-gold-500 mb-7" />
          <p className="text-[2rem] leading-[1.2] font-semibold tracking-tight text-balance">
            Деньги компании —<br />на одном экране
          </p>
          <p className="mt-4 text-brand-200/80 leading-relaxed">
            Сколько заработали, куда ушло и хватит ли на следующий месяц. Без таблиц, которые понимает только их автор.
          </p>

          <ul className="mt-10 space-y-6">
            {POINTS.map(p => (
              <li key={p.title} className="flex gap-4">
                <span className="w-9 h-9 rounded-xl bg-white/[0.07] ring-1 ring-white/10 flex items-center justify-center shrink-0">
                  <p.icon className="w-[18px] h-[18px] text-gold-400" strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{p.title}</span>
                  <span className="block mt-0.5 text-sm text-brand-200/70">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  )
}

/** Подпись над полем формы входа */
export function AuthField({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      {children}
      {hint && <div className="mt-1.5 text-xs text-gray-500">{hint}</div>}
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const authInput = cn(fieldClass(), 'h-11 px-3.5')

/** Пароль с «глазом»: опечатку в скрытом поле не видно, а вход с третьей попытки раздражает */
export function PasswordInput({ className, ...rest }) {
  const [shown, setShown] = useState(false)
  const Icon = shown ? EyeOff : Eye
  return (
    <div className="relative">
      <input type={shown ? 'text' : 'password'} className={cn(authInput, 'pr-11', className)} {...rest} />
      <button type="button" onClick={() => setShown(v => !v)}
        title={shown ? 'Скрыть пароль' : 'Показать пароль'} aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700">
        <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
      </button>
    </div>
  )
}
