import { useState } from 'react'
import { samples } from '../../core/index'
import type { LogoDesign } from '../../core/index'
import type { RuntimeMode } from '../../lib/runtime-mode'

type Props = {
  busy: boolean
  mode: RuntimeMode | null
  activeModel: string | null
  onGenerate: (brief: string) => void
  onSample: (design: LogoDesign) => void
  onOpenSettings: () => void
}

export function PromptBar({
  busy,
  mode,
  activeModel,
  onGenerate,
  onSample,
  onOpenSettings,
}: Props) {
  const [brief, setBrief] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = brief.trim()
    if (trimmed && !busy) onGenerate(trimmed)
  }

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark" aria-hidden="true">
          <svg viewBox="-3 -3 6 6" width="26" height="26">
            <circle cx="0" cy="-0.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="0.12" />
            <circle cx="0" cy="0.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="0.12" />
            <path
              d="M -1.52 0 A 1.6 1.6 0 0 1 1.52 0 A 1.6 1.6 0 0 1 -1.52 0 Z"
              fill="currentColor"
              opacity="0.85"
            />
          </svg>
        </span>
        <div>
          <strong>geo-logo</strong>
          <small>円と直線で構成するロゴジェネレータ</small>
        </div>
      </div>

      <form className="topbar__form" onSubmit={submit}>
        <input
          type="text"
          value={brief}
          placeholder="例: 山と川を円弧で表した、地質調査会社のマーク"
          onChange={(e) => setBrief(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn" disabled={busy || !brief.trim()}>
          {busy ? '設計中…' : '設計する'}
        </button>
      </form>

      <div className="topbar__meta">
        <select
          defaultValue=""
          onChange={(e) => {
            const found = samples.find((s) => s.name === e.target.value)
            if (found) onSample(found)
            e.target.value = ''
          }}
        >
          <option value="" disabled>
            サンプルを読み込む
          </option>
          {samples.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={activeModel ? 'chip chip--on' : 'chip chip--warn'}
          onClick={onOpenSettings}
          title="AI 設定を開く"
        >
          {activeModel ?? 'モデル未設定'}
          {mode === 'static' && <span className="chip__mode">static</span>}
        </button>
      </div>
    </header>
  )
}
