import { useEffect, useRef, useState } from 'react'
import { roleName } from '../utils/permissions'

/**
 * Кто вошёл — кружком с инициалами, остальное в выпадающем списке.
 *
 * Раньше имя, должность и «Выйти» стояли в шапке текстом. У длинных имён вроде
 * «Финансовый директор · Администратор» это съедало четверть строки, и правая
 * группа вместе с «Недавними» и справкой уезжала на вторую строку — тем
 * заметнее, чем длиннее название компании слева.
 *
 * Кружок занимает 32 пикселя вместо трёхсот, а имя, должность и выход никуда не
 * делись: они в списке, который открывается нажатием. Пропадать из шапки должно
 * то, что читают раз в день, а не то, чем пользуются.
 */

/** «Финансовый директор» → «ФД». Одно слово — две первые буквы */
const initialsOf = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '—'

  return words.length === 1
    ? words[0].slice(0, 2).toUpperCase()
    : (words[0][0] + words[1][0]).toUpperCase()
}

export default function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => {
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }

    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [])

  const role = roleName()

  return (
    <div className="relative shrink-0" ref={boxRef}>
      <button
        onClick={() => setOpen(!open)}
        title={role ? `${user?.name} · ${role}` : (user?.name || 'Профиль')}
        className={`w-8 h-8 rounded-full text-xs font-semibold transition-colors ${
          open
            ? 'bg-blue-900 text-white'
            : 'bg-blue-50 text-blue-900 hover:bg-blue-100'
        }`}
      >
        {initialsOf(user?.name)}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
          <div className="px-4 py-2.5">
            <div className="text-sm font-medium text-gray-800 break-words">{user?.name}</div>
            {/* Должность здесь, а не в шапке: человек смотрит её, когда
                разбирается, почему часть разделов ему не видна */}
            {role && <div className="text-xs text-gray-400 mt-0.5">{role}</div>}
            {user?.email && <div className="text-xs text-gray-400 mt-0.5 break-all">{user.email}</div>}
          </div>

          <button
            onClick={() => { setOpen(false); onLogout() }}
            className="block w-full text-left px-4 py-2 text-sm text-gray-600 border-t border-gray-100
                       hover:bg-red-50 hover:text-red-600 transition-colors"
          >
            Выйти
          </button>
        </div>
      )}
    </div>
  )
}
