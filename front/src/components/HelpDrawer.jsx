import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import HelpArticle from './HelpArticle'
import { articleForRoute, bySlug, groups, search } from '../help'

/**
 * Справка сбоку, поверх страницы.
 *
 * Главное здесь — не уводить со страницы: справка, ради которой надо бросить
 * работу и пойти искать, не читается. Кнопка «?» в шапке открывает статью
 * именно про то, что сейчас на экране; всё остальное — оглавление и поиск —
 * лежит в той же панели, чтобы не заводить второй способ.
 *
 * Страница `/help` показывает те же статьи шире и для чтения подряд.
 */
export default function HelpDrawer({ onClose }) {
  const location = useLocation()
  const navigate = useNavigate()

  // Открываемся на статье про текущую страницу; для страницы без статьи —
  // на оглавлении, а не на пустом экране с извинениями
  const [slug, setSlug] = useState(() => articleForRoute(location.pathname)?.slug || null)
  const [query, setQuery] = useState('')

  // Esc закрывает: панель перекрывает часть экрана, и мышью до крестика ещё
  // надо дойти
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const found   = search(query)
  const article = slug ? bySlug[slug] : null
  const showing = query.trim().length >= 2 ? 'search' : article ? 'article' : 'index'

  return (
    <div className="fixed inset-0 z-[80] flex justify-end">
      {/* Затемнение слабее обычного: под ним остаётся страница, ради которой
          справку и открыли, — её должно быть видно */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      <aside className="relative w-full max-w-md bg-white shadow-2xl flex flex-col h-full">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          {showing === 'article' && (
            <button onClick={() => setSlug(null)} title="К оглавлению"
              className="text-gray-400 hover:text-gray-600 text-sm px-1">←</button>
          )}
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Поиск по справке"
            className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button onClick={onClose} title="Закрыть (Esc)"
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {showing === 'search' ? (
            found.length === 0
              ? <div className="text-[13px] text-gray-400 py-8 text-center">Ничего не нашлось</div>
              : <div className="space-y-3">
                  {found.map(a => (
                    <button key={a.slug} onClick={() => { setSlug(a.slug); setQuery('') }}
                      className="block w-full text-left group">
                      <div className="text-[13px] font-medium text-gray-800 group-hover:text-blue-700">{a.title}</div>
                      {a.snippet && <div className="text-[12px] text-gray-500 mt-0.5">{a.snippet}</div>}
                    </button>
                  ))}
                </div>
          ) : showing === 'article' ? (
            <HelpArticle text={article.text} />
          ) : (
            <div className="space-y-5">
              {/* Оправдываемся только если статьи и правда нет: к оглавлению
                  приходят и сознательно, стрелкой из статьи */}
              {!articleForRoute(location.pathname) && (
                <p className="text-[13px] text-gray-500">
                  Для этой страницы статьи пока нет. Вот всё, что уже написано:
                </p>
              )}
              {groups().map(g => (
                <div key={g.name}>
                  <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1.5">{g.name}</div>
                  <div className="space-y-2">
                    {g.items.map(a => (
                      <button key={a.slug} onClick={() => setSlug(a.slug)}
                        className="block w-full text-left group">
                        <div className="text-[13px] font-medium text-gray-800 group-hover:text-blue-700">{a.title}</div>
                        <div className="text-[12px] text-gray-500">{a.lead}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100">
          <button onClick={() => { onClose(); navigate('/help') }}
            className="text-[12px] text-blue-700 hover:underline">
            Открыть справку целиком →
          </button>
        </div>
      </aside>
    </div>
  )
}
