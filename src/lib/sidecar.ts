import { apiUrl, isTauri } from './api-base'

/**
 * デスクトップ版のバックエンド（同梱 Node + Hono）の起動と健全性確認。
 *
 * ブラウザの静的モードでは CORS と CSP に阻まれて外部から素材を取得できず、
 * API キーも localStorage に置くしかない。デスクトップ版ではサイドカーが
 * その両方を引き受ける。
 *
 * 構成は Graphium から移植。特に「古いサイドカーの再利用」への対処は、
 * 自動更新のあとで新しい API が 404 になるという分かりにくい事故の防止策。
 */

export type SidecarStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'ready'; pid: number; version: string }
  | { state: 'failed'; message: string }

const HEALTH_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 300

type Health = { ok?: boolean; pid?: number; version?: string }

async function fetchHealth(signal?: AbortSignal): Promise<Health | null> {
  try {
    const res = await fetch(apiUrl('api/health'), {
      headers: { accept: 'application/json' },
      signal,
    })
    if (!res.ok) return null
    return (await res.json()) as Health
  } catch {
    return null
  }
}

/** 期待するアプリのバージョン。Tauri から取得できなければ照合しない。 */
async function appVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return null
  }
}

async function invokeCommand(name: string, args?: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(name, args)
}

/**
 * サイドカーを起動して疎通するまで待つ。
 *
 * すでに動いているものがあれば再利用するが、バージョンが食い違う場合だけは
 * 作り直す。自動更新の直後に旧版のサイドカーが生き残っていると、ポートを
 * 握ったままなので新しい API ルートが 404 になる。
 */
export async function ensureSidecar(
  onStatus?: (status: SidecarStatus) => void,
): Promise<SidecarStatus> {
  if (!isTauri()) return { state: 'idle' }

  const report = (s: SidecarStatus) => {
    onStatus?.(s)
    return s
  }
  report({ state: 'starting' })

  const expected = await appVersion()
  const existing = await fetchHealth()

  if (existing?.ok) {
    const stale = expected !== null && existing.version !== undefined && existing.version !== expected
    if (!stale) {
      return report({
        state: 'ready',
        pid: existing.pid ?? 0,
        version: existing.version ?? 'unknown',
      })
    }
    // 版が違う＝更新前の自分が残っている。始末してから作り直す
    try {
      await invokeCommand('stop_sidecar')
    } catch {
      // 既に居ないだけかもしれないので握りつぶす
    }
  }

  try {
    await invokeCommand('start_sidecar', {})
  } catch (err) {
    return report({
      state: 'failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }

  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    const health = await fetchHealth()
    if (health?.ok) {
      return report({
        state: 'ready',
        pid: health.pid ?? 0,
        version: health.version ?? 'unknown',
      })
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  return report({
    state: 'failed',
    message: `バックエンドが ${HEALTH_TIMEOUT_MS / 1000} 秒以内に応答しませんでした`,
  })
}
