import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { resetRuntimeModeCache } from './lib/runtime-mode'
import { ensureSidecar } from './lib/sidecar'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root が見つかりません')

/**
 * クリックジャッキング対策。
 *
 * 本来は `frame-ancestors` / `X-Frame-Options` で塞ぐが、GitHub Pages は
 * HTTP ヘッダーを設定できず、CSP を meta で配ると frame-ancestors は
 * 仕様上無視される。そのため実行時に埋め込みを検出して描画を止める。
 *
 * このアプリは API キーをメモリに持ち、ワンクリックで課金リクエストを
 * 発行できるので、他サイトの iframe 内で動かす理由がない。
 */
if (window.top !== window.self) {
  root.textContent =
    'geo-logo は iframe 内では動作しません。元のページを直接開いてください。'
} else {
  // デスクトップ版では同梱バックエンドを先に起こす。応答を待たずに描画を
  // 始めてよい（設定画面もモード表示も、後から server へ切り替わる）。
  // 起動に失敗しても静的モードとして動くので、ここで止めない。
  void ensureSidecar((status) => {
    if (status.state === 'failed') {
      console.error('[sidecar]', status.message)
    } else if (status.state === 'ready') {
      resetRuntimeModeCache()
    }
  })

  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
