import { useRef, useState } from 'react'
import type { Message } from './types'

/**
 * AI との対話。
 *
 * 参照素材は「作図モード」ではなく、この対話に添えるものとして扱う。
 * 素材を使うかどうかは作りたいものによって決まることで、利用者に道具の
 * 内部事情（トレースするのかしないのか）を選ばせる筋合いではない。
 */

export type ChatPaneProps = {
  messages: Message[]
  busy: boolean
  reference: string | null
  onSend: (text: string) => void
  onAttach: (name: string, svg: string) => void
  onDetach: () => void
  onRestore: (message: Message) => void
}

export default function ChatPane({
  messages,
  busy,
  reference,
  onSend,
  onAttach,
  onDetach,
  onRestore,
}: ChatPaneProps) {
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    onSend(value)
  }

  return (
    <aside className="chat">
      <div className="chat__log">
        {messages.length === 0 && (
          <p className="chat__hint">
            作りたいマークを書いてください。参考にしたい形があれば添えられます。
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat__msg chat__msg--${m.role}`}>
            <p>{m.text}</p>
            {m.reference && <span className="chat__ref">参照: {m.reference}</span>}
            {m.design && (
              <button type="button" className="btn btn--ghost" onClick={() => onRestore(m)}>
                この時点に戻す
              </button>
            )}
          </div>
        ))}
        {busy && <div className="chat__msg chat__msg--assistant">…作図しています</div>}
      </div>

      <div className="chat__compose">
        {reference && (
          <div className="chat__attached">
            参照: {reference}
            <button type="button" onClick={onDetach} aria-label="参照を外す">
              ×
            </button>
          </div>
        )}
        <textarea
          value={text}
          rows={3}
          placeholder="例: 山と川を円弧で表した、地質調査会社のマーク（⌘/Ctrl + Enter で送信）"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // 変換中の確定を送信として拾わない。日本語入力では Enter が
            // 「漢字を確定する」ためのキーで、送信の意図とは限らない
            if (e.nativeEvent.isComposing) return
            // 送信は修飾キー付きだけ。Enter そのものは改行
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="chat__actions">
          <button type="button" className="btn btn--ghost" onClick={() => fileRef.current?.click()}>
            参照を添える
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".svg,image/svg+xml"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const svg = await file.text()
              if (/<svg[\s>]/i.test(svg)) onAttach(file.name, svg)
              e.target.value = ''
            }}
          />
          <button type="button" className="btn" disabled={busy || !text.trim()} onClick={submit}>
            送信
          </button>
        </div>
      </div>
    </aside>
  )
}
