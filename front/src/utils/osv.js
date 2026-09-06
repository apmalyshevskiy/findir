/**
 * Оборотка: развёртка деревьев и состав выгрузки в Excel.
 *
 * Вынесено из страницы, потому что это чистые функции над данными отчёта: их
 * можно прогнать на настоящих цифрах и сверить с экраном, не поднимая браузер.
 * Выгрузка обязана повторять экран — иначе человек смотрит на остаток со
 * знаком, а в файле получает дебет с кредитом.
 */

/** Остаток со знаком: дебет минус кредит */
export const calcNet = (debit, credit) => (debit || 0) - (credit || 0)

/**
 * Дерево аналитик от сервера (children[].children[]) — в плоский список.
 * Разворачиваем только раскрытые узлы: свёрнутых на экране не видно.
 */
export const flattenServerTree = (nodes, expandedSet, biId, depth = 0) => {
  let result = []
  nodes.forEach(node => {
    const nodeKey = `${biId}-${node.info_id}-${node.info_type}`
    const isExp   = expandedSet.has(nodeKey)
    result.push({ ...node, depth, _key: nodeKey, _expanded: isExp })
    if (node.children?.length > 0 && isExp) {
      result = result.concat(flattenServerTree(node.children, expandedSet, biId, depth + 1))
    }
  })
  return result
}

/** Дерево счетов (account_children) — в плоский список, тоже по раскрытым */
export const flattenAccountTree = (nodes, expandedSet, depth = 0) => {
  let result = []
  nodes.forEach(node => {
    const isExp = expandedSet.has(node.bi_id)
    result.push({ ...node, _depth: depth, _expanded: isExp })
    if (node.account_children?.length > 0 && isExp) {
      result = result.concat(flattenAccountTree(node.account_children, expandedSet, depth + 1))
    }
  })
  return result
}

// ─── Выгрузка в Excel ─────────────────────────────────────────────────────────

const money = (v) => ({ v: v || 0, t: 'n', z: '#,##0.00 "₽"' })
const qty   = (v) => ({ v: v || 0, t: 'n', z: '#,##0.###' })
const DASH  = { v: '—', t: 's' }

/**
 * Колонки выгрузки — те же и в том же порядке, что в шапке таблицы.
 *
 * saldo:   у аналитики «только обороты» сальдо не имеет смысла — прочерк.
 * needQty: счёт без количественного учёта — тоже прочерк, а не ноль.
 *
 * @param balanceMode 'net' | 'debit_credit'
 * @param displayMode 'amount' | 'qty' | 'both'
 */
export function osvColumns(balanceMode, displayMode) {
  const wantAmt = displayMode !== 'qty'
  const wantQty = displayMode !== 'amount'

  const columns = []
  const col = (header, get, opts = {}) => columns.push({ header, get, ...opts })

  if (balanceMode === 'net') {
    if (wantAmt) col('Остаток нач.', r => money(calcNet(r.opening_debit, r.opening_credit)), { saldo: true })
    if (wantQty) col('Остаток нач., кол-во', r => qty(calcNet(r.qty_opening, r.qty_opening_neg)), { saldo: true, needQty: true })
  } else {
    if (wantAmt) {
      col('Сальдо нач. (Дт)', r => money(r.opening_debit),  { saldo: true })
      col('Сальдо нач. (Кт)', r => money(r.opening_credit), { saldo: true })
    }
    if (wantQty) {
      col('Сальдо нач., кол-во (Дт)', r => qty(r.qty_opening),     { saldo: true, needQty: true })
      col('Сальдо нач., кол-во (Кт)', r => qty(r.qty_opening_neg), { saldo: true, needQty: true })
    }
  }

  // Обороты идут дебетом и кредитом в обоих режимах — так же, как на экране
  if (wantAmt) {
    col('Обороты (Дт)', r => money(r.debit))
    col('Обороты (Кт)', r => money(r.credit))
  }
  if (wantQty) {
    col('Обороты, кол-во (Дт)', r => qty(r.qty_debit),  { needQty: true })
    col('Обороты, кол-во (Кт)', r => qty(r.qty_credit), { needQty: true })
  }

  if (balanceMode === 'net') {
    if (wantAmt) col('Остаток кон.', r => money(calcNet(r.closing_debit, r.closing_credit)), { saldo: true })
    if (wantQty) col('Остаток кон., кол-во', r => qty(calcNet(r.qty_closing, r.qty_closing_neg)), { saldo: true, needQty: true })
  } else {
    if (wantAmt) {
      col('Сальдо кон. (Дт)', r => money(r.closing_debit),  { saldo: true })
      col('Сальдо кон. (Кт)', r => money(r.closing_credit), { saldo: true })
    }
    if (wantQty) {
      col('Сальдо кон., кол-во (Дт)', r => qty(r.qty_closing),     { saldo: true, needQty: true })
      col('Сальдо кон., кол-во (Кт)', r => qty(r.qty_closing_neg), { saldo: true, needQty: true })
    }
  }

  return columns
}

/**
 * Лист выгрузки как массив строк.
 *
 * Строки — ровно те, что видны на экране: свёрнутый счёт и свёрнутая аналитика
 * в файл не попадают. Нужна вся аналитика — сначала «Раскрыть аналитику».
 */
export function osvSheet({
  data, totals, balanceMode, displayMode,
  hierarchyAccounts, expandedAccounts, expanded, expandedInfo,
}) {
  const columns = osvColumns(balanceMode, displayMode)

  const cells = (row, { hasQty = true, turnoverOnly = false } = {}) =>
    columns.map(c => {
      if (c.saldo && turnoverOnly) return DASH
      if (c.needQty && !hasQty)    return DASH
      return c.get(row)
    })

  const rows = [['Счёт', ...columns.map(c => c.header)]]

  const visible = hierarchyAccounts ? flattenAccountTree(data, expandedAccounts) : data

  visible.forEach(row => {
    const indent = '    '.repeat(row._depth ?? 0)

    rows.push([
      `${indent}${row.code} ${row.name}`,
      ...cells(row, { hasQty: row.has_quantity }),
    ])

    if (!expanded.has(row.bi_id)) return

    flattenServerTree(row.children || [], expandedInfo, row.bi_id).forEach(child => {
      rows.push([
        `${indent}${'    '.repeat(child.depth + 1)}└ ${child.info_name}`,
        ...cells(child, { hasQty: row.has_quantity, turnoverOnly: child.turnover_only }),
      ])
    })
  })

  rows.push([])
  // Количество по счетам не складываем: килограммы и штуки в одну сумму не
  // сходятся. На экране в этих колонках итог тоже прочерк
  rows.push(['ИТОГО', ...columns.map(c => c.needQty ? DASH : c.get(totals))])

  return { rows, widths: [{ wch: 40 }, ...columns.map(() => ({ wch: 18 }))] }
}
