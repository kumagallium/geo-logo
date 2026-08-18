import { titleOf, type Session } from './types'

/** 過去の設計。行き来しながら詰めるので、捨てずに並べておく。 */
export default function HistoryPane({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  storagePath,
  onOpenStorage,
}: {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  /** 履歴を書いているフォルダ。サーバーが居ないとき（静的配信）は null */
  storagePath?: string | null
  /** フォルダを OS で開く。デスクトップ版だけ渡す */
  onOpenStorage?: () => void
}) {
  return (
    <nav className="history">
      <button type="button" className="btn history__new" onClick={onCreate}>
        新しい設計
      </button>
      <ul>
        {sessions.map((s) => (
          <li key={s.id} className="history__row">
            <button
              type="button"
              className={s.id === activeId ? 'history__item history__item--on' : 'history__item'}
              onClick={() => onSelect(s.id)}
            >
              <span>{titleOf(s)}</span>
              <em>{s.messages.length > 0 ? `${s.messages.length} 往復` : '未着手'}</em>
            </button>
            {/* 最後の 1 本が未着手のときだけ隠す。消しても同じ殻が出るだけなので */}
            {(sessions.length > 1 || s.messages.length > 0) && (
              <button
                type="button"
                className="history__delete"
                aria-label={`「${titleOf(s)}」を削除`}
                title="削除"
                onClick={() => onDelete(s.id)}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {storagePath && (
        <p className="history__where" title={storagePath}>
          <span>保存先: {storagePath}</span>
          {onOpenStorage && (
            <button type="button" className="btn btn--ghost" onClick={onOpenStorage}>
              フォルダを開く
            </button>
          )}
        </p>
      )}
    </nav>
  )
}
