/**
 * Счёт операции: код в цветной пилюле и название рядом.
 *
 * Отдельным компонентом — ради закрытых счетов. Должность может не видеть,
 * скажем, расчёты с сотрудниками: тогда сервер присылает вместо счёта признак
 * hidden, и на его месте появляется серая пилюля «Скрыто». Показать пустое
 * место было бы хуже — человек решил бы, что в операции чего-то не хватает.
 *
 * Дебет зелёный, кредит красный — как во всём остальном приложении.
 */

import LockIcon from './LockIcon'
import { Highlight } from '../utils/infoSearch'

const TONE = {
  debit:  'bg-green-50 text-green-700',
  credit: 'bg-red-50 text-red-700',
}

// Код счёта в начале названия («А51 Расчётные счета») дублирует пилюлю
const stripCode = (name) => name?.replace(/^[А-ЯA-Z]\d+\s/, '')

/** q — строка поиска из журнала: по подсветке видно, за что зацепилась операция */
export default function AccountChip({ code, name, hidden, side = 'debit', size = 'text-xs', q = '' }) {
  if (hidden) {
    return (
      <span className={`${size} inline-flex items-center gap-1 bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-medium`}
        title="Счёт закрыт для вашей должности">
        <LockIcon className="w-3 h-3" />
        Скрыто
      </span>
    )
  }

  return (
    <>
      <span className={`${size} ${TONE[side]} px-1.5 py-0.5 rounded font-mono font-medium`}>
        <Highlight text={code} q={q} />
      </span>
      <span className={`${size} text-gray-600`}>
        <Highlight text={stripCode(name)} q={q} />
      </span>
    </>
  )
}
