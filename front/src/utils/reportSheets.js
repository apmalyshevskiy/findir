/**
 * Листы выгрузки баланса и ОДДС.
 *
 * Здесь же, а не на страницах: сборка листа — это правила про состав колонок и
 * отступы, и их место рядом с такими же правилами для оборотки (utils/osv.js),
 * а не в вёрстке. Числа отдаём числами, а не строками: иначе в Excel по ним
 * нельзя ни суммировать, ни строить график.
 */

const money = (v) => (v == null || v === '' || isNaN(v)) ? 0 : Number(Number(v).toFixed(2))

const indent = (depth) => '    '.repeat(depth)

/** Баланс: актив и пассив друг под другом, с итогами каждого */
export function balanceSheetRows(report) {
  const compare = !!report?.compare_at
  const head = ['Статья', `На ${report.at}`]
  if (compare) head.push(`На ${report.compare_at}`, 'Изменение')

  const rows = [head]

  const line = (name, amount, compareAmount, depth = 0) => {
    const r = [`${indent(depth)}${name}`, money(amount)]
    if (compare) r.push(money(compareAmount), money(amount - compareAmount))
    return r
  }

  for (const section of report.sections || []) {
    rows.push([])
    rows.push(line(section.label.toUpperCase(), section.total, section.compare_total))

    for (const row of section.rows || []) {
      rows.push(line(`${row.code ? row.code + ' ' : ''}${row.name}`, row.amount, row.compare_amount, 1))

      for (const child of row.children || []) {
        rows.push(line(`${child.code ? child.code + ' ' : ''}${child.name}`, child.amount, child.compare_amount, 2))
      }
    }
  }

  rows.push([])
  rows.push(line('ИТОГО АКТИВ', report.totals?.assets, report.totals?.assets_compare))
  rows.push(line('ИТОГО ПАССИВ', report.totals?.passive, report.totals?.passive_compare))

  return { rows, widths: [{ wch: 46 }, ...head.slice(1).map(() => ({ wch: 18 }))] }
}

/** ОДДС: остаток на начало, разделы, остаток на конец */
export function cashFlowSheetRows(report) {
  const rows = [['Статья', 'Поступления', 'Выплаты', 'Чистый поток']]

  rows.push(['Остаток на начало', '', '', money(report.opening)])

  const walk = (items, depth) => {
    for (const item of items || []) {
      rows.push([
        `${indent(depth)}${item.name}`,
        money(item.sub_in), money(item.sub_out), money(item.sub_net),
      ])
      walk(item.children, depth + 1)
    }
  }

  for (const section of report.sections || []) {
    rows.push([])
    rows.push([section.label.toUpperCase(), money(section.in), money(section.out), money(section.net)])
    walk(section.rows, 1)
  }

  rows.push([])
  rows.push(['Чистый поток за период', '', '', money(report.net)])
  rows.push(['Остаток на конец', '', '', money(report.closing)])

  return { rows, widths: [{ wch: 46 }, { wch: 16 }, { wch: 16 }, { wch: 16 }] }
}
