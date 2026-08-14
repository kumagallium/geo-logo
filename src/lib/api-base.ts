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
