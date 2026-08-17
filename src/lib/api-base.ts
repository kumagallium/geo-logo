/**
 * API の宛先。
 *
 * Web 版は Vite の proxy（開発）や同一オリジン配信（本番）で相対パスが通るが、
 * デスクトップ版は画面が tauri://localhost から読み込まれるため、相対パスでは
 * サイドカーへ届かない。ここで一箇所に集約する。
 */

/** Tauri のデスクトップ版で動いているか */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** サイドカーが待ち受けるポート。Rust 側の DEFAULT_PORT と合わせる。 */
export const SIDECAR_PORT = 8787

/**
 * API のベース URL。末尾はスラッシュで終わる。
 *
 * 127.0.0.1 を使う（localhost ではなく）。localhost は環境によって ::1 に
 * 解決され、IPv4 だけで待ち受けるサーバーに繋がらないことがある。
 */
export function apiBase(): string {
  return isTauri() ? `http://127.0.0.1:${SIDECAR_PORT}/` : import.meta.env.BASE_URL
}

/** API のパスを絶対 URL にする（先頭スラッシュ不要） */
export function apiUrl(path: string): string {
  return `${apiBase()}${path.replace(/^\/+/, '')}`
}

/**
 * サイドカー宛の fetch。
 *
 * デスクトップ版の画面は tauri://localhost（セキュアコンテキスト）から配られる。
 * そこから http://127.0.0.1:8787 への **素の fetch は mixed content でブロック**
 * される（実測: WebView から TypeError: Load failed、XHR は status 0。CSP を
 * 完全に外しても再現するので CSP ではない）。Tauri の HTTP プラグインは Rust 側で
 * リクエストを実行するので、WebView の mixed content 制限を受けない。
 *
 * ブラウザ版（Pages / dev）は素の fetch のまま——同一オリジンなので mixed content
 * にならず、プラグインも存在しない。
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = apiUrl(path)
  if (isTauri()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    return tauriFetch(url, init)
  }
  return fetch(url, init)
}
