import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
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
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
