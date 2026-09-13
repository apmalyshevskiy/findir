import { render } from '../help'

/**
 * Тело статьи справки.
 *
 * Оформление задаём здесь, а не глобальным стилем: справка — единственное место
 * в программе, где HTML приходит из markdown, и общие правила для h2/ul задели
 * бы всю вёрстку. Селекторы по потомкам держат это в одном классе.
 *
 * Ширина строки ограничена: справку читают текстом, а не сканируют глазами, и
 * на широком мониторе строка в полтора экрана не читается.
 */
const PROSE = [
  'text-[13px] leading-relaxed text-gray-700',
  '[&>h1]:text-lg [&>h1]:font-semibold [&>h1]:text-gray-900 [&>h1]:mb-3',
  '[&>h2]:text-sm [&>h2]:font-semibold [&>h2]:text-gray-900 [&>h2]:mt-6 [&>h2]:mb-2',
  '[&>h3]:text-[13px] [&>h3]:font-semibold [&>h3]:text-gray-800 [&>h3]:mt-4 [&>h3]:mb-1.5',
  '[&>p]:mb-3 [&>p]:max-w-[68ch]',
  '[&>ul]:mb-3 [&>ul]:pl-5 [&>ul]:list-disc [&>ul]:max-w-[68ch] [&>ul>li]:mb-1',
  '[&>ol]:mb-3 [&>ol]:pl-5 [&>ol]:list-decimal [&>ol]:max-w-[68ch] [&>ol>li]:mb-1',
  '[&_strong]:font-semibold [&_strong]:text-gray-900',
  '[&_code]:bg-gray-100 [&_code]:text-gray-800 [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]',
  '[&_a]:text-blue-700 [&_a]:underline',
  '[&>blockquote]:border-l-2 [&>blockquote]:border-amber-300 [&>blockquote]:bg-amber-50/60 [&>blockquote]:px-3 [&>blockquote]:py-2 [&>blockquote]:mb-3 [&>blockquote]:text-gray-700 [&>blockquote>p]:mb-0',
  // Таблицы уезжают за край на узкой панели — пусть прокручиваются сами
  '[&>table]:block [&>table]:overflow-x-auto [&>table]:mb-4 [&>table]:text-[12px]',
  '[&_th]:text-left [&_th]:font-medium [&_th]:text-gray-500 [&_th]:px-2 [&_th]:py-1 [&_th]:border-b [&_th]:border-gray-200 [&_th]:whitespace-nowrap',
  '[&_td]:px-2 [&_td]:py-1 [&_td]:border-b [&_td]:border-gray-100 [&_td]:align-top',
  '[&>hr]:my-5 [&>hr]:border-gray-100',
].join(' ')

export default function HelpArticle({ text }) {
  return <div className={PROSE} dangerouslySetInnerHTML={{ __html: render(text) }} />
}
