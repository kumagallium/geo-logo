import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = Number(process.env.GEOLOGO_PORT ?? 8787)

// GitHub Pages はリポジトリ名のサブパス配下（例 /geo-logo/）で配信されるため、
// ビルド時に base を差し替えられるようにしておく。CI が
// GEOLOGO_BASE=/<repo>/ を渡す。ローカル / 独自ドメインでは "/" のまま。
const base = process.env.GEOLOGO_BASE ?? '/'

/**
 * Pages 向けの本番ビルドにだけ CSP を meta で埋め込む。
 *
 * GitHub Pages は HTTP ヘッダーを設定できないので meta http-equiv を使う。
 * dev に同じ meta を置くと Vite の HMR が注入する inline style / eval を
 * 塞いで開発できなくなるため、production のみに限定する。
 *
 * **デスクトップ版では出さない**（GEOLOGO_TARGET=desktop）。この meta は
 * connect-src を `https:` に絞り upgrade-insecure-requests まで付けるので、
 * デスクトップ版がサイドカー（http://127.0.0.1:8787）へ出す fetch を握り潰す
 * （実測: WebView から TypeError: Load failed。IPC は通るのに http だけ落ちる）。
 * デスクトップ版の CSP は tauri.conf.json 側が持ち、そちらは 127.0.0.1 を許す。
 *
 * 要点:
 *   script-src 'self'  — インライン script も onload= 等のイベント属性も禁止。
 *                        SVG を dangerouslySetInnerHTML で入れる設計なので、
 *                        スキーマ検証（core/dsl.ts）に次ぐ第二の壁になる。
 *   connect-src        — プロバイダーのエンドポイントはユーザーが自由に設定できる
 *                        （openai-compatible）ため host は絞れない。https に限定して
 *                        平文送信だけは塞ぐ。
 */
function cspPlugin(): Plugin {
  // デスクトップ版（Tauri）は tauri.conf.json の CSP を使う。meta は出さない
  const forDesktop = process.env.GEOLOGO_TARGET === 'desktop'
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https:",
    "base-uri 'none'",
    "form-action 'none'",
    'upgrade-insecure-requests',
    // frame-ancestors は meta 経由だと仕様上無視される（ブラウザが警告を出す）。
    // GitHub Pages は HTTP ヘッダーを設定できないので、埋め込み対策は
    // src/main.tsx の実行時チェックで行う。
  ].join('; ')

  return {
    name: 'geologo-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const tags = [
        {
          tag: 'meta' as const,
          attrs: { name: 'referrer', content: 'no-referrer' },
          injectTo: 'head-prepend' as const,
        },
      ]
      // Pages 版だけ meta CSP を出す。デスクトップ版は tauri.conf の CSP に任せる
      if (!forDesktop) {
        tags.unshift({
          tag: 'meta' as const,
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy } as Record<string, string>,
          injectTo: 'head-prepend' as const,
        } as (typeof tags)[number])
      }
      return { html, tags }
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), cspPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    // paper.js と AI SDK 一式でチャンクが大きくなるが、単一ページの
    // ツールなので分割しても初回描画は速くならない。警告だけ黙らせる。
    chunkSizeWarningLimit: 1500,
  },
})
