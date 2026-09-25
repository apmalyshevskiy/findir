/**
 * Справка: статьи и их связь со страницами.
 *
 * Тексты лежат рядом, в `*.md`, и попадают в сборку — они описывают программу,
 * а не данные компании. Поэтому не в базе: справка одинакова для всех тенантов
 * и обязана меняться тем же коммитом, что и функция, которую описывает. Заодно
 * не нужны ни миграции, ни перенос текстов между стендами.
 *
 * Заголовок статьи не дублируем в реестре — берём из первой строки файла:
 * иначе они разъезжаются, и в списке одно, а в тексте другое.
 */

import { marked } from 'marked'

const RAW = import.meta.glob('./*.md', { query: '?raw', import: 'default', eager: true })

/**
 * Реестр: порядок в списке, раздел и страницы, с которых открывается статья.
 *
 * `routes` — точные пути маршрутов. Кнопка «?» на странице открывает ту статью,
 * в чьём списке есть её путь; страница без статьи показывает оглавление.
 */
const ARTICLES = [
  { slug: 'start',       group: 'Начало',        routes: ['/dashboard'] },
  { slug: 'accounts',    group: 'Учёт',          routes: ['/balance-items'] },
  { slug: 'dictionaries',group: 'Учёт',          routes: ['/info'] },
  { slug: 'operations',  group: 'Учёт',          routes: ['/operations'] },
  { slug: 'documents',   group: 'Учёт',          routes: ['/documents', '/document-types'] },
  { slug: 'osv',         group: 'Отчётность',    routes: ['/balance-sheet'] },
  { slug: 'budget',      group: 'Планирование',  routes: ['/budget', '/payment-calendar'] },
  { slug: 'statement',   group: 'Обмен данными', routes: ['/bank-statement', '/classification-rules'] },
  { slug: 'onec',        group: 'Обмен данными', routes: ['/onec-postings'] },
  // Настройка интеграций ушла из статьи про 1С: 1С обменивается файлом и
  // настраивается на своей странице, а здесь связь по сети и общий экран
  // загрузки на все подключённые системы
  { slug: 'exchange',    group: 'Обмен данными', routes: ['/data-import', '/integrations'] },
  { slug: 'access',      group: 'Доступ',        routes: ['/users', '/roles', '/edit-lock-date'] },
  { slug: 'history',     group: 'Доступ',        routes: ['/change-log'] },
]

/** Заголовок — первая строка вида «# Название» */
const titleOf = (text) => (text.match(/^#\s+(.+)$/m)?.[1] || '').trim()

/**
 * Первый абзац — он же подпись в оглавлении.
 *
 * Ищем первую строку, которая не заголовок и не пустая: писать подпись
 * отдельным полем значит однажды забыть её обновить.
 */
const leadOf = (text) => {
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (l && !l.startsWith('#')) return l.replace(/[*_`]/g, '')
  }
  return ''
}

export const articles = ARTICLES.map(a => {
  const text = RAW[`./${a.slug}.md`] || ''

  return { ...a, text, title: titleOf(text) || a.slug, lead: leadOf(text) }
})

export const bySlug = Object.fromEntries(articles.map(a => [a.slug, a]))

/** Статья для страницы приложения или null, если для неё ещё не написали */
export const articleForRoute = (pathname) =>
  articles.find(a => a.routes.includes(pathname)) || null

/** Разделы оглавления в порядке появления в реестре */
export const groups = () => {
  const out = []
  for (const a of articles) {
    let g = out.find(x => x.name === a.group)
    if (!g) out.push(g = { name: a.group, items: [] })
    g.items.push(a)
  }
  return out
}

/**
 * Поиск по подстроке в заголовке и тексте.
 *
 * Клиентский: статьи уже в сборке, ходить на сервер не за чем. Показываем
 * кусок текста вокруг найденного — по одному заголовку не понять, та ли статья.
 */
export const search = (query) => {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []

  const out = []
  for (const a of articles) {
    const hay = a.text.toLowerCase()
    const at  = hay.indexOf(q)
    if (at === -1 && !a.title.toLowerCase().includes(q)) continue

    let snippet = ''
    if (at !== -1) {
      const from = Math.max(0, at - 60)
      snippet = (from > 0 ? '…' : '') + a.text.slice(from, at + q.length + 90).replace(/[#*`>\n]+/g, ' ').trim() + '…'
    }

    out.push({ ...a, snippet })
  }
  return out
}

marked.setOptions({ breaks: false, gfm: true })

/** Готовый HTML статьи. Источник наш, в репозитории — чистить нечего */
export const render = (text) => marked.parse(text || '')
