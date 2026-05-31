import { useState, useEffect } from 'react'
import {
  getCategoryPostings, createCategoryPosting, updateCategoryPosting, deleteCategoryPosting,
} from '../api/categoryPostings'
import {
  getClassificationRules, createClassificationRule, updateClassificationRule, deleteClassificationRule,
} from '../api/classificationRules'
import { getInfo } from '../api/info'
import { getBalanceItems } from '../api/operations'
import Layout from '../components/Layout'

const ic = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

const DIRECTIONS = [
  { value: 'any', label: 'Любое' },
  { value: 'in',  label: 'Приход' },
  { value: 'out', label: 'Расход' },
]
const DIR_LABEL = { any: 'Любое', in: 'Приход', out: 'Расход' }

const PARTNER_MODES = [
  { value: 'from_inn', label: 'Подбирать по ИНН' },
  { value: 'none',     label: 'Не заполнять' },
]

const emptyPosting = { category: '', counter_account_code: '', flow_info_id: '', partner_mode: 'from_inn', is_active: true }
const emptyRule = {
  direction: 'any', inn: '', purpose_keywords: '', has_kbk: false,
  amount_min: '', amount_max: '', category: '', priority: 50, is_active: true,
}

export default function ClassificationRulesPage() {
  const [postings, setPostings] = useState([])
  const [rules, setRules] = useState([])
  const [accounts, setAccounts] = useState([])
  const [flows, setFlows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // формы
  const [postingForm, setPostingForm] = useState(null)   // null = закрыта, иначе объект
  const [postingEditId, setPostingEditId] = useState(null)
  const [ruleForm, setRuleForm] = useState(null)
  const [ruleEditId, setRuleEditId] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const [p, r, a, f] = await Promise.all([
        getCategoryPostings(),
        getClassificationRules(),
        getBalanceItems(),
        getInfo({ type: 'flow' }),
      ])
      setPostings(p.data.data || [])
      setRules(r.data.data || [])
      setAccounts(a.data.data || [])
      setFlows(f.data.data || [])
    } catch (e) {
      setError('Не удалось загрузить данные')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  // справочные мапы
  const accByCode = Object.fromEntries(accounts.map(a => [a.code, a]))
  const flowById = Object.fromEntries(flows.map(f => [f.id, f]))
  const knownCategories = [...new Set(postings.map(p => p.category))].sort()
  const categoriesWithoutPosting = new Set(
    rules.map(r => r.category).filter(c => c && !knownCategories.includes(c))
  )

  // ── Разноска ──
  const openPostingNew = () => { setPostingEditId(null); setPostingForm({ ...emptyPosting }) }
  const openPostingEdit = (p) => {
    setPostingEditId(p.id)
    setPostingForm({
      category: p.category || '',
      counter_account_code: p.counter_account_code || '',
      flow_info_id: p.flow_info_id || '',
      partner_mode: p.partner_mode || 'from_inn',
      is_active: !!p.is_active,
    })
  }
  const savePosting = async () => {
    setError('')
    const payload = {
      category: postingForm.category.trim(),
      counter_account_code: postingForm.counter_account_code || null,
      flow_info_id: postingForm.flow_info_id || null,
      partner_mode: postingForm.partner_mode,
      is_active: postingForm.is_active,
    }
    try {
      if (postingEditId) await updateCategoryPosting(postingEditId, payload)
      else await createCategoryPosting(payload)
      setPostingForm(null); setPostingEditId(null)
      load()
    } catch (e) {
      setError(e.response?.data?.message || e.response?.data?.errors?.category?.[0] || 'Ошибка сохранения разноски')
    }
  }
  const removePosting = async (id) => {
    if (!confirm('Удалить разноску?')) return
    try { await deleteCategoryPosting(id); load() } catch { setError('Ошибка удаления') }
  }

  // ── Правила ──
  const openRuleNew = () => { setRuleEditId(null); setRuleForm({ ...emptyRule }) }
  const openRuleEdit = (r) => {
    setRuleEditId(r.id)
    setRuleForm({
      direction: r.direction || 'any',
      inn: r.inn || '',
      purpose_keywords: r.purpose_keywords || '',
      has_kbk: !!r.has_kbk,
      amount_min: r.amount_min ?? '',
      amount_max: r.amount_max ?? '',
      category: r.category || '',
      priority: r.priority ?? 50,
      is_active: !!r.is_active,
    })
  }
  const saveRule = async () => {
    setError('')
    const payload = {
      direction: ruleForm.direction,
      inn: ruleForm.inn || null,
      purpose_keywords: ruleForm.purpose_keywords || null,
      has_kbk: ruleForm.has_kbk,
      amount_min: ruleForm.amount_min === '' ? null : ruleForm.amount_min,
      amount_max: ruleForm.amount_max === '' ? null : ruleForm.amount_max,
      category: ruleForm.category.trim(),
      priority: ruleForm.priority === '' ? 50 : Number(ruleForm.priority),
      is_active: ruleForm.is_active,
    }
    try {
      if (ruleEditId) await updateClassificationRule(ruleEditId, payload)
      else await createClassificationRule(payload)
      setRuleForm(null); setRuleEditId(null)
      load()
    } catch (e) {
      setError(e.response?.data?.message || 'Ошибка сохранения правила')
    }
  }
  const removeRule = async (id) => {
    if (!confirm('Удалить правило?')) return
    try { await deleteClassificationRule(id); load() } catch { setError('Ошибка удаления') }
  }

  return (
    <Layout>
      <div className="max-w-6xl mx-auto py-6 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Правила автозаполнения</h1>
          <p className="text-sm text-gray-500 mt-1">
            Разноска задаёт, куда проводить категорию (счёт и статью ДДС). Правила распознают строку выписки и присваивают категорию.
          </p>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
        {loading && <div className="text-gray-400 text-sm">Загрузка…</div>}

        {/* ───── Секция РАЗНОСКА ───── */}
        <section className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Разноска по категориям</h2>
              <p className="text-xs text-gray-500">Категория → корр-счёт, статья ДДС, контрагент</p>
            </div>
            <button onClick={openPostingNew} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
              + Категория
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="py-2 pr-4">Категория</th>
                  <th className="py-2 pr-4">Корр-счёт</th>
                  <th className="py-2 pr-4">Статья ДДС</th>
                  <th className="py-2 pr-4">Контрагент</th>
                  <th className="py-2 pr-4"></th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {postings.map(p => {
                  const acc = accByCode[p.counter_account_code]
                  const flow = flowById[p.flow_info_id]
                  return (
                    <tr key={p.id} className={'border-b border-gray-50 ' + (p.is_active ? '' : 'opacity-50')}>
                      <td className="py-2.5 pr-4 font-mono text-xs">{p.category}</td>
                      <td className="py-2.5 pr-4">
                        {p.counter_account_code
                          ? <span><span className="font-mono text-gray-500">{p.counter_account_code}</span>{acc ? ` — ${acc.name}` : ''}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 pr-4">{flow ? flow.name : (p.flow_info_id ? `#${p.flow_info_id}` : <span className="text-gray-300">—</span>)}</td>
                      <td className="py-2.5 pr-4 text-xs text-gray-500">
                        {p.partner_mode === 'from_inn' ? 'по ИНН' : (p.partner_mode === 'none' ? '—' : <span className="text-amber-600">не задан</span>)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <button onClick={() => openPostingEdit(p)} className="text-blue-600 hover:underline text-xs">изменить</button>
                      </td>
                      <td className="py-2.5">
                        <button onClick={() => removePosting(p.id)} className="text-gray-300 hover:text-red-500 text-xs">удалить</button>
                      </td>
                    </tr>
                  )
                })}
                {postings.length === 0 && !loading && (
                  <tr><td colSpan={6} className="py-4 text-gray-400 text-center">Нет разносок</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ───── Секция ПРАВИЛА ───── */}
        <section className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Правила классификации</h2>
              <p className="text-xs text-gray-500">Проверяются по убыванию приоритета, первое совпадение побеждает</p>
            </div>
            <button onClick={openRuleNew} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
              + Правило
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="py-2 pr-4">Приор.</th>
                  <th className="py-2 pr-4">Направл.</th>
                  <th className="py-2 pr-4">ИНН</th>
                  <th className="py-2 pr-4">Ключевые слова</th>
                  <th className="py-2 pr-4">Категория</th>
                  <th className="py-2 pr-4">Срабат.</th>
                  <th className="py-2 pr-4"></th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.id} className={'border-b border-gray-50 ' + (r.is_active ? '' : 'opacity-50')}>
                    <td className="py-2.5 pr-4 text-gray-500">{r.priority}</td>
                    <td className="py-2.5 pr-4 text-xs">{DIR_LABEL[r.direction] || r.direction}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">{r.inn || <span className="text-gray-300">—</span>}</td>
                    <td className="py-2.5 pr-4 text-xs text-gray-600 max-w-xs truncate" title={r.purpose_keywords}>{r.purpose_keywords || <span className="text-gray-300">—</span>}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">
                      {r.category}
                      {categoriesWithoutPosting.has(r.category) && (
                        <span className="ml-1 text-amber-600" title="Нет разноски для этой категории">⚠</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-gray-400">{r.hit_count ?? 0}</td>
                    <td className="py-2.5 pr-4">
                      <button onClick={() => openRuleEdit(r)} className="text-blue-600 hover:underline text-xs">изменить</button>
                    </td>
                    <td className="py-2.5">
                      <button onClick={() => removeRule(r.id)} className="text-gray-300 hover:text-red-500 text-xs">удалить</button>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && !loading && (
                  <tr><td colSpan={8} className="py-4 text-gray-400 text-center">Нет правил</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* datalist категорий — общий для обеих форм */}
      <datalist id="known-categories">
        {knownCategories.map(c => <option key={c} value={c} />)}
      </datalist>

      {/* ───── Модалка РАЗНОСКА ───── */}
      {postingForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setPostingForm(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">{postingEditId ? 'Разноска' : 'Новая разноска'}</h3>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Категория</label>
              <input list="known-categories" value={postingForm.category}
                onChange={e => setPostingForm({ ...postingForm, category: e.target.value })}
                placeholder="CUSTOMER_PAYMENT" className={ic + ' font-mono'} />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Корр-счёт</label>
              <select value={postingForm.counter_account_code}
                onChange={e => setPostingForm({ ...postingForm, counter_account_code: e.target.value })} className={ic}>
                <option value="">— Не задан</option>
                {accounts.map(a => <option key={a.id} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Статья ДДС</label>
              <select value={postingForm.flow_info_id}
                onChange={e => setPostingForm({ ...postingForm, flow_info_id: e.target.value })} className={ic}>
                <option value="">— Не задана</option>
                {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Контрагент</label>
              <select value={postingForm.partner_mode}
                onChange={e => setPostingForm({ ...postingForm, partner_mode: e.target.value })} className={ic}>
                {PARTNER_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={postingForm.is_active}
                onChange={e => setPostingForm({ ...postingForm, is_active: e.target.checked })} />
              Активна
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setPostingForm(null)} className="px-4 py-2 text-gray-600 text-sm">Отмена</button>
              <button onClick={savePosting} disabled={!postingForm.category.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* ───── Модалка ПРАВИЛО ───── */}
      {ruleForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setRuleForm(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">{ruleEditId ? 'Правило' : 'Новое правило'}</h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Направление</label>
                <select value={ruleForm.direction}
                  onChange={e => setRuleForm({ ...ruleForm, direction: e.target.value })} className={ic}>
                  {DIRECTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Приоритет</label>
                <input type="number" value={ruleForm.priority}
                  onChange={e => setRuleForm({ ...ruleForm, priority: e.target.value })} className={ic} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ключевые слова в назначении</label>
              <textarea value={ruleForm.purpose_keywords} rows={2}
                onChange={e => setRuleForm({ ...ruleForm, purpose_keywords: e.target.value })}
                placeholder="пополнение лицевого счета|для оплаты лицензии" className={ic} />
              <p className="text-xs text-gray-400 mt-1">Несколько вариантов через | (вертикальная черта). Совпадение любой подстроки.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ИНН контрагента</label>
                <input value={ruleForm.inn}
                  onChange={e => setRuleForm({ ...ruleForm, inn: e.target.value })}
                  placeholder="точное совпадение" className={ic + ' font-mono'} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Категория</label>
                <input list="known-categories" value={ruleForm.category}
                  onChange={e => setRuleForm({ ...ruleForm, category: e.target.value })}
                  placeholder="CUSTOMER_PAYMENT" className={ic + ' font-mono'} />
                {ruleForm.category.trim() && !knownCategories.includes(ruleForm.category.trim()) && (
                  <p className="text-xs text-amber-600 mt-1">Нет разноски для этой категории — счёт и статья не подставятся.</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Сумма от</label>
                <input type="number" step="0.01" value={ruleForm.amount_min}
                  onChange={e => setRuleForm({ ...ruleForm, amount_min: e.target.value })} className={ic} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Сумма до</label>
                <input type="number" step="0.01" value={ruleForm.amount_max}
                  onChange={e => setRuleForm({ ...ruleForm, amount_max: e.target.value })} className={ic} />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ruleForm.has_kbk}
                onChange={e => setRuleForm({ ...ruleForm, has_kbk: e.target.checked })} />
              Требовать заполненный КБК (налоги)
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ruleForm.is_active}
                onChange={e => setRuleForm({ ...ruleForm, is_active: e.target.checked })} />
              Активно
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setRuleForm(null)} className="px-4 py-2 text-gray-600 text-sm">Отмена</button>
              <button onClick={saveRule} disabled={!ruleForm.category.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
