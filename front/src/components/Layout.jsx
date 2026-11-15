import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Fragment, useState, useEffect } from 'react'
import {
  Archive, ArrowLeftRight, Banknote, BookOpen, CalendarDays, ChevronDown, CircleHelp, CreditCard, Download,
  FileInput, FileText, Files, FolderKanban, Gauge, History, Landmark, LayoutDashboard, ListTree, Lock, Menu,
  PanelLeftClose, PanelLeftOpen, PiggyBank, Plug, Scale, ShieldCheck, Sparkles, Split, Table2, Target, Users,
  Wand2, X,
} from 'lucide-react'
import TenantSwitcher from './TenantSwitcher'
import HelpDrawer from './HelpDrawer'
import RecentMenu from './RecentMenu'
import UserMenu from './UserMenu'
import ObjectOpener from './ObjectOpener'
import DemoSeeder from './DemoSeeder'
import Logo from './Logo'
import { TopBusy } from './Busy'
import { toast } from './ui'
import api from '../api/client'
import { listAccounts, clearAccounts } from '../utils/accounts'
import { canView } from '../utils/permissions'
import usePersistedState from '../hooks/usePersistedState'
import { cn } from '../lib/utils'

/**
 * Поля и предельная ширина страницы. Потолок широкий: главные экраны —
 * таблицы по месяцам и дням, и на большом мониторе им нужна вся ширина, а не
 * колонка посередине.
 */
const SHELL = 'max-w-[1760px] mx-auto px-4 md:px-6'

export default function Layout({ children }) {
  const navigate = useNavigate()
  const location = useLocation()

  // Пользователь с правами лежит в localStorage с момента входа. Освежаем его
  // при каждом заходе на страницу: администратор мог сменить должность, и
  // человек не должен ради этого перелогиниваться
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}') } catch { return {} }
  })

  useEffect(() => {
    api.get('/me')
      .then(r => {
        if (!r.data?.user) return
        localStorage.setItem('user', JSON.stringify(r.data.user))
        setUser(r.data.user)
      })
      .catch(() => { /* 401 обработает перехватчик, остальное не мешает работать */ })
  }, [location.pathname])

  const [helpOpen, setHelpOpen] = useState(false)

  /**
   * Боковое меню.
   *
   * Меню жило в шапке выпадающими разделами и на экранах уже 1536 пикселей
   * переносилось на вторую строку: шесть разделов плюс компания, «недавние»,
   * справка и профиль в одну не помещались. Чтобы попасть в «Оборотку», нужно
   * было открыть «Отчётность» и только потом увидеть, что там есть.
   *
   * Слева все разделы видны сразу, а таблицам остаётся вся высота экрана.
   * Панель сворачивается в полосу значков — на ноутбуке ширина нужнее отчёту,
   * чем подписям, которые человек давно знает. И то и другое запоминается.
   */
  const [collapsed, setCollapsed] = usePersistedState('ui:navCollapsed', window.innerWidth < 1280)
  // (на экране уже 1280 панель с самого начала свёрнута: там ширина нужнее)
  // «Настройки» по умолчанию свёрнуты: в них одиннадцать пунктов, и заходят
  // туда раз в месяц, а не каждый день
  const [closedGroups, setClosedGroups] = usePersistedState('ui:navClosed', { 'Настройки': true })
  // На узком экране панель выезжает поверх страницы по кнопке
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileAt, setMobileAt] = useState(location.pathname)
  // Перешли в раздел — выезжавшая панель своё дело сделала. В рендере, а не
  // эффектом: иначе она на кадр остаётся поверх уже новой страницы
  if (mobileAt !== location.pathname) { setMobileAt(location.pathname); setMobileOpen(false) }

  // Отказ по правам — уведомлением поверх страницы. Ловим событие от axios:
  // так сообщение появится с любой страницы, не требуя от каждой своей обработки
  useEffect(() => {
    const onForbidden = (e) => toast.warning(e.detail, { duration: 6000 })
    window.addEventListener('findir:forbidden', onForbidden)
    return () => window.removeEventListener('findir:forbidden', onForbidden)
  }, [])

  /**
   * «Выйти» — из всех подключённых компаний сразу: за общим компьютером это
   * ожидаемое поведение, а оставить чужую базу открытой было бы неприятным
   * сюрпризом. Отключить одну компанию можно в списке рядом с её названием.
   */
  const logout = () => {
    const accounts = listAccounts()
    import('../api/client').then(({ default: api }) => {
      const all = accounts.map(a =>
        api.post('/logout', {}, { headers: { Authorization: `Bearer ${a.token}` } }).catch(() => {})
      )
      Promise.all(all).finally(() => {
        clearAccounts()
        localStorage.clear()
        navigate('/login')
      })
    })
  }

  // У пунктов меню указан раздел прав: закрытые не показываем. Настоящая
  // проверка — на сервере, здесь лишь бы не звать человека в закрытую дверь
  const nav = [
    // Помощник первым и сам по себе: с него часто начинают ввод
    { icon: Sparkles, path: '/ai', label: 'AI-помощник', section: 'ai' },
    // Меню собрано по тому, что человек делает: сначала вводят, потом смотрят,
    // потом планируют. Раньше эти же семь пунктов лежали в ряд, и разница между
    // «завести операцию» и «посмотреть оборотку» ничем не показывалась
    {
      label: 'Учёт',
      children: [
        { icon: ArrowLeftRight, path: '/operations', label: 'Операции',    section: 'operations' },
        { icon: FileText, path: '/documents',  label: 'Документы',   section: 'documents' },
        // Контрагенты, статьи, сотрудники, кассы — это содержимое операций и
        // документов, а не настройка системы: заводят их по ходу работы
        { icon: BookOpen, path: '/info',       label: 'Справочники', section: 'dictionaries' },
      ],
    },
    {
      label: 'Отчётность',
      children: [
        { icon: LayoutDashboard, path: '/dashboard',          label: 'Дашборд',         section: 'dashboard' },
        { icon: Table2, path: '/balance-sheet',      label: 'Оборотка',        section: 'reports' },
        { icon: Scale, path: '/reports/balance',    label: 'Баланс',          section: 'reports' },
        { icon: Banknote, path: '/reports/cash-flow',  label: 'Движение денег',  section: 'reports' },
      ],
    },
    {
      label: 'Планирование',
      children: [
        { icon: Target, path: '/budget',           label: 'Бюджет',               section: 'budget' },
        { icon: CalendarDays, path: '/payment-calendar', label: 'Платёжный календарь',  section: 'budget' },
        { icon: PiggyBank, path: '/fund-planning',    label: 'Фонды',                section: 'budget' },
        { icon: Split, path: '/fund-schemes',     label: 'Модели распределения', section: 'budget' },
      ],
    },
    // Всё, что приходит в базу извне, — в одном разделе: и разовая загрузка
    // файла выписки, и обмен с учётной системой вместе с его настройкой.
    // Порознь это выглядело как разные умения, хотя задача одна
    {
      label: 'Обмен данными',
      children: [
        { icon: Landmark, path: '/bank-statement', label: 'Банковская выписка',        section: 'exchange' },
        { icon: FileInput, path: '/onec-postings',  label: 'Проводки из 1С',            section: 'exchange' },
        { icon: Download, path: '/data-import',    label: 'Загрузка из учётных систем', section: 'exchange' },
        { icon: Plug, path: '/integrations',   label: 'Настройка интеграций',       section: 'exchange' },
      ],
    },
    // Настройки разбиты подзаголовками внутри самого списка: пунктов набралось
    // на десяток, и сплошным столбцом в них уже приходилось вчитываться.
    // Подзаголовок показывается, только если в группе уцелел хоть один пункт
    // после проверки прав
    {
      label: 'Настройки',
      children: [
        { icon: FolderKanban, path: '/projects',             label: 'Проекты',           section: 'dictionaries', group: 'Справочники' },
        { icon: ListTree, path: '/balance-items',        label: 'План счетов',       section: 'dictionaries', group: 'Справочники' },
        { icon: Files, path: '/document-types',       label: 'Виды документов',   section: 'dictionaries', group: 'Справочники' },

        { icon: Users, path: '/users',                label: 'Пользователи',      section: 'users',    group: 'Доступ' },
        { icon: ShieldCheck, path: '/roles',                label: 'Должности',         section: 'users',    group: 'Доступ' },
        // Дата запрета — тоже про доступ, только не «кому», а «до какого числа»
        { icon: Lock, path: '/edit-lock-date',       label: 'Дата запрета',      section: 'settings', group: 'Доступ' },
        // Журнал изменений — в «Доступ»: им пользуются, когда разбираются, кто
        // что сделал, а это тот же круг вопросов, что должности и дата запрета
        { icon: History, path: '/change-log',           label: 'Журнал изменений',  section: 'settings', group: 'Доступ' },

        { icon: Wand2, path: '/classification-rules', label: 'Настройка правил',  section: 'dictionaries', group: 'Прочее' },
        { icon: CreditCard, path: '/acquiring-fee-rules',  label: 'Эквайринг',         section: 'settings',     group: 'Прочее' },
        // «Интеграции» переехали в «Обмен данными» — там же, где сама загрузка
        { icon: Gauge, path: '/ai-usage',             label: 'Расход на ИИ',      section: 'settings',     group: 'Прочее' },
        { icon: Archive, path: '/backup',               label: 'Архивная копия',    section: 'backup',       group: 'Прочее' },
      ],
    },
  ].map(item => item.children
    ? { ...item, children: item.children.filter(c => canView(c.section)) }
    : item
  ).filter(item => item.children ? item.children.length > 0 : canView(item.section))

  const isGroupActive = (item) => item.children?.some(c => location.pathname === c.path)

  /** Пункт меню — ссылка: открывается в новой вкладке средней кнопкой и по Ctrl */
  const item = (c, narrow) => (
    <NavLink key={c.path} to={c.path} title={narrow ? c.label : undefined}
      className={({ isActive }) => cn(
        'group relative flex items-center gap-3 h-9 rounded-lg text-[13px] font-medium transition-colors',
        narrow ? 'justify-center px-0' : 'px-3',
        isActive
          ? 'bg-white/10 text-white'
          : 'text-brand-200/80 hover:bg-white/5 hover:text-white',
      )}>
      {({ isActive }) => (
        <>
          {/* Золотая метка — единственное цветное пятно панели: глаз находит
              текущий раздел, не читая подписей */}
          {isActive && <span className="absolute left-0 top-2 bottom-2 w-[3px] -ml-2 rounded-full bg-gold-500" />}
          <c.icon className={cn('w-[18px] h-[18px] shrink-0', isActive ? 'text-gold-400' : 'text-brand-300/70 group-hover:text-brand-100')}
            strokeWidth={1.75} aria-hidden="true" />
          {!narrow && <span className="truncate">{c.label}</span>}
        </>
      )}
    </NavLink>
  )

  const sidebar = (narrow) => (
    <div className="flex flex-col h-full">
      {/* Знак не ссылка: раздел «Дашборд» открыт не всякой должности, и
          логотип, ведущий в отказ по правам, — плохая кнопка */}
      <div className={cn('flex items-center gap-2.5 h-14 shrink-0', narrow ? 'justify-center' : 'px-5')}>
        <Logo size={26} light />
        {/* Разрядка — вместо отдельного шрифта под логотип: слово из шести
            прописных без неё выглядит сжатым рядом со знаком */}
        {!narrow && <span className="text-lg font-semibold tracking-[0.12em] text-white">FINDIR</span>}
      </div>

      <nav className={cn('flex-1 overflow-y-auto overscroll-contain pb-4 findir-nav-scroll', narrow ? 'px-2' : 'px-4')}>
        {nav.map(n => {
          if (!n.children) return <div key={n.path} className="mb-1">{item(n, narrow)}</div>

          // Раздел с открытой страницей не сворачивается: иначе текущее место
          // пропадает из меню
          const closed = !narrow && closedGroups[n.label] && !isGroupActive(n)
          return (
            <div key={n.label} className="mt-4">
              {narrow
                ? <div className="mx-2 mb-2 border-t border-white/10" />
                : (
                  <button type="button" aria-expanded={!closed}
                    onClick={() => setClosedGroups(g => ({ ...g, [n.label]: !closed }))}
                    className="flex items-center justify-between w-full px-3 mb-1 h-6 text-2xs font-semibold uppercase tracking-[0.08em] text-brand-300/60 hover:text-brand-100">
                    {n.label}
                    <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', closed && '-rotate-90')} aria-hidden="true" />
                  </button>
                )}
              {!closed && (
                <div className="space-y-0.5">
                  {n.children.map((c, i) => (
                    <Fragment key={c.path}>
                      {/* Подзаголовок — у первого уцелевшего пункта группы.
                          Считаем по уже отфильтрованному списку, поэтому
                          группа, из которой правами вычистили всё, не
                          оставляет висящего заголовка */}
                      {!narrow && c.group && c.group !== n.children[i - 1]?.group && (
                        <div className={cn('px-3 pb-0.5 text-2xs text-brand-300/45', i === 0 ? 'pt-0.5' : 'pt-2')}>
                          {c.group}
                        </div>
                      )}
                      {item(c, narrow)}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <div className={cn('shrink-0 border-t border-white/10 py-2 hidden lg:block', narrow ? 'px-2' : 'px-4')}>
        <button type="button" onClick={() => setCollapsed(v => !v)}
          title={narrow ? 'Развернуть меню' : 'Свернуть меню в значки'}
          className={cn('flex items-center gap-3 w-full h-9 rounded-lg text-[13px] text-brand-300/70 hover:bg-white/5 hover:text-white transition-colors',
            narrow ? 'justify-center' : 'px-3')}>
          {narrow
            ? <PanelLeftOpen className="w-[18px] h-[18px]" strokeWidth={1.75} aria-hidden="true" />
            : <><PanelLeftClose className="w-[18px] h-[18px]" strokeWidth={1.75} aria-hidden="true" /> Свернуть</>}
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Общий индикатор работы: любой запрос к API виден сразу, на какой бы
          странице он ни ушёл */}
      <TopBusy />

      {/* Панель на широком экране: закреплена, страница прокручивается рядом */}
      <aside className={cn(
        'hidden lg:block fixed inset-y-0 left-0 z-40 bg-brand-950 transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60',
      )}>
        {sidebar(collapsed)}
      </aside>

      {/* Панель на узком экране: выезжает поверх страницы */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-[250]">
          <div className="absolute inset-0 bg-brand-950/50 animate-fade-in" onClick={() => setMobileOpen(false)} />
          <aside className="relative w-64 h-full bg-brand-950 shadow-pop">
            {sidebar(false)}
            <button type="button" aria-label="Закрыть меню" onClick={() => setMobileOpen(false)}
              className="absolute top-3.5 right-3 p-1.5 rounded-lg text-brand-200 hover:bg-white/10">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </aside>
        </div>
      )}

      <div className={cn('transition-[padding] duration-200', collapsed ? 'lg:pl-16' : 'lg:pl-60')}>
        {/* Верхняя полоса: в какой компании работаем и личная группа. Меню в
            ней больше нет, поэтому она в одну строку на любом экране */}
        <header className="bg-white border-b border-gray-200">
          <div className={`${SHELL} h-14 flex items-center gap-3`}>
            <button type="button" aria-label="Меню" onClick={() => setMobileOpen(true)}
              className="lg:hidden -ml-1 p-2 rounded-lg text-gray-600 hover:bg-gray-100">
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>

            {/* Название компании и переключение баз — см. TenantSwitcher */}
            <TenantSwitcher />
            {/* Тариф (trial/plan) переедет в настройки → подписка */}

            <div className="flex items-center gap-2 lg:gap-3 shrink-0 ml-auto">
              {/* Недавно открытые — личный список, живёт в браузере */}
              <RecentMenu />

              {/* Справка про текущую страницу — одним нажатием и не уходя с неё */}
              <button type="button" onClick={() => setHelpOpen(true)} title="Справка по этой странице"
                aria-label="Справка по этой странице"
                className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-brand-700 hover:bg-brand-50 transition-colors shrink-0">
                <CircleHelp className="w-[18px] h-[18px]" aria-hidden="true" />
              </button>

              {/* Имя, должность и выход — в кружке с инициалами */}
              <UserMenu user={user} onLogout={logout} />
            </div>
          </div>
        </header>

        {helpOpen && <HelpDrawer onClose={() => setHelpOpen(false)} />}

        {/* Открывает объект поверх любой страницы — по зову из журнала
            изменений и списка недавних */}
        <ObjectOpener />

        {/* Заполнение чистой компании демо-данными. Кнопки нет: вызывается
            набором слова «demo» — см. сам компонент */}
        <DemoSeeder />

        <main className={`${SHELL} py-5 md:py-6`}>{children}</main>
      </div>
    </div>
  )
}
