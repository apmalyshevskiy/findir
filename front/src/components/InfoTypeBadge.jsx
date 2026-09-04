/**
 * Стикер типа статьи справочника.
 *
 * Названия статей из разных справочников похожи до неразличимости: «Аренда»
 * бывает статьёй расходов, статьёй ДДС и товаром-услугой. Пока типа не видно,
 * люди дописывают его прямо в название — «ЗП бренд-шеф (ДДС)». Стикер снимает
 * эту нужду: тип виден у каждой строки, у каждого типа свой цвет.
 */

const BADGES = {
  partner:    { label: 'Контрагент', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  product:    { label: 'Товар',      cls: 'bg-violet-50 text-violet-700 ring-violet-200' },
  cash:       { label: 'Касса',      cls: 'bg-teal-50 text-teal-700 ring-teal-200' },
  employee:   { label: 'Сотрудник',  cls: 'bg-orange-50 text-orange-700 ring-orange-200' },
  revenue:    { label: 'Доход',      cls: 'bg-green-50 text-green-700 ring-green-200' },
  expenses:   { label: 'Расход',     cls: 'bg-red-50 text-red-600 ring-red-200' },
  department: { label: 'Отдел',      cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
  flow:       { label: 'ДДС',        cls: 'bg-blue-50 text-blue-700 ring-blue-200' },
}

export default function InfoTypeBadge({ type, className = '' }) {
  const badge = BADGES[type]
  if (!badge) return null
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ring-1 whitespace-nowrap align-middle ${badge.cls} ${className}`}>
      {badge.label}
    </span>
  )
}
