/**
 * Поиск по справочнику и подсветка найденного.
 *
 * Ищем не только по названию: контрагента чаще помнят по ИНН, статью — по коду,
 * а свой же элемент из формы операции — по номеру, который там показан решёткой.
 * Поэтому «7707083893», «02.01» и «#128» находят каждый своё.
 *
 * Жило в InfoPage; вынесено сюда, когда выбор справочника стал общим
 * компонентом, — иначе поиск в справочниках и в документах разошёлся бы.
 */

export const matchesSearch = (item, q) => {
  const needle = String(q ?? '').trim().toLowerCase()
  if (!needle) return true

  // «#128» и просто «128» — это про идентификатор, но по числу ищем и в
  // остальных полях: код статьи тоже бывает числом
  if (needle.startsWith('#')) return String(item.id) === needle.slice(1)

  // Номер сверяем целиком: по подстроке «1» нашлась бы половина справочника
  if (String(item.id) === needle) return true

  return [item.name, item.code, item.inn, item.description]
    .some(v => v && String(v).toLowerCase().includes(needle))
}

/**
 * Подсветка найденного — глазу проще зацепиться в длинном списке.
 *
 * Отмечаем все вхождения, а не первое: в назначении платежа из выписки
 * искомое слово встречается по нескольку раз, и подсвеченное первое посреди
 * трёх строк текста только сбивает с толку.
 */
export const Highlight = ({ text, q }) => {
  const needle = String(q ?? '').trim()
  if (!text) return null
  if (!needle || needle.startsWith('#')) return <>{text}</>

  const s     = String(text)
  const lower = s.toLowerCase()
  const nlow  = needle.toLowerCase()

  if (!lower.includes(nlow)) return <>{s}</>

  const parts = []
  let from = 0

  for (let i = lower.indexOf(nlow); i >= 0; i = lower.indexOf(nlow, from)) {
    if (i > from) parts.push(s.slice(from, i))
    parts.push(
      <mark key={i} className="bg-amber-100 text-inherit rounded-sm px-0.5">{s.slice(i, i + needle.length)}</mark>
    )
    from = i + needle.length
  }
  if (from < s.length) parts.push(s.slice(from))

  return <>{parts}</>
}
