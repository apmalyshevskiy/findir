import { useState } from 'react'
import Layout from '../components/Layout'
import HelpArticle from '../components/HelpArticle'
import { articles, bySlug, groups, search } from '../help'

/**
 * Справка целиком: оглавление слева, статья справа.
 *
 * Панель из шапки отвечает на вопрос «что это за экран». Здесь читают подряд —
 * когда разбираются в разделе с нуля, а не спотыкаются о конкретное поле.
 */
export default function HelpPage() {
  const [slug, setSlug]   = useState(articles[0]?.slug || null)
  const [query, setQuery] = useState('')

  const found   = search(query)
  const article = slug ? bySlug[slug] : null
  const searching = query.trim().length >= 2

  return (
    <Layout>
      <div className="mb-5">
        <h1 className="text-[1.375rem] leading-7 font-semibold tracking-tight text-gray-900">Справка</h1>
        <p className="text-sm text-gray-500 mt-1">
          Кнопка <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-300 text-2xs align-middle">?</span> в шапке
          открывает статью про ту страницу, на которой вы находитесь
        </p>
      </div>

      <div className="flex gap-5 items-start">
        {/* Оглавление липнет к экрану: статьи длинные, и возвращаться к списку
            прокруткой вверх было бы утомительно */}
        <aside className="w-60 shrink-0 sticky top-4">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Поиск по справке"
            className="w-full mb-3 px-2.5 py-1.5 border border-gray-200 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500" />

          <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-3 space-y-4 max-h-[70vh] overflow-y-auto">
            {groups().map(g => (
              <div key={g.name}>
                <div className="text-2xs uppercase tracking-wide text-gray-400 mb-1">{g.name}</div>
                <div className="space-y-0.5">
                  {g.items.map(a => (
                    <button key={a.slug} onClick={() => { setSlug(a.slug); setQuery('') }}
                      className={`block w-full text-left px-2 py-1 rounded text-[13px] transition-colors ${
                        !searching && slug === a.slug
                          ? 'bg-brand-50 text-brand-800 font-medium'
                          : 'text-gray-600 hover:bg-gray-50'
                      }`}>
                      {a.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <div className="flex-1 bg-white rounded-xl border border-gray-200/80 shadow-card p-6 min-w-0">
          {searching ? (
            found.length === 0
              ? <div className="text-[13px] text-gray-400 py-10 text-center">Ничего не нашлось</div>
              : <div className="space-y-4">
                  <div className="text-xs text-gray-500">Нашлось статей: {found.length}</div>
                  {found.map(a => (
                    <button key={a.slug} onClick={() => { setSlug(a.slug); setQuery('') }}
                      className="block w-full text-left group">
                      <div className="text-sm font-medium text-gray-800 group-hover:text-brand-700">{a.title}</div>
                      {a.snippet && <div className="text-[12px] text-gray-500 mt-0.5">{a.snippet}</div>}
                    </button>
                  ))}
                </div>
          ) : article ? (
            <HelpArticle text={article.text} />
          ) : (
            <div className="text-[13px] text-gray-400 py-10 text-center">Выберите статью слева</div>
          )}
        </div>
      </div>
    </Layout>
  )
}
