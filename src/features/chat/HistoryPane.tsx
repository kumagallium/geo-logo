import { titleOf, type Session } from './types'

/** 過去の設計。行き来しながら詰めるので、捨てずに並べておく。 */
export default function HistoryPane({
  sessions,
  activeId,
  onSelect,
  onCreate,
}: {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
}) {
  return (
    <nav className="history">
      <button type="button" className="btn history__new" onClick={onCreate}>
        新しい設計
      </button>
      <ul>
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={s.id === activeId ? 'history__item history__item--on' : 'history__item'}
              onClick={() => onSelect(s.id)}
            >
              <span>{titleOf(s)}</span>
              <em>{s.messages.length > 0 ? `${s.messages.length} 往復` : '未着手'}</em>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
