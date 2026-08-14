// 実行モードの判定
//
// Graphium の ServerMode ("node" | "vercel") に対応する geo-logo の区分。
//
//   server : ローカルの `pnpm dev` / セルフホスト。Hono が動いており、
//            API キーはサーバー側 data/models.json（+ macOS Keychain）に保存する。
//            LLM 呼び出しもサーバーが行うので CORS の制約を受けない。
//
//   static : GitHub Pages などの静的配信。サーバーが存在しないので、モデル設定は
//            ブラウザの localStorage に保存し、プロバイダー API をブラウザから
//            直接叩く。Graphium の "vercel" モード（クライアント保持 + ヘッダー送信）
//            の考え方をそのまま、送信先だけサーバーからプロバイダーへ変えたもの。

import { apiUrl } from './api-base'

export type RuntimeMode = 'server' | 'static'

let cached: RuntimeMode | null = null
let probe: Promise<RuntimeMode> | null = null

/**
 * /api/health に到達できるかで判定する。静的配信では 404 か
 * index.html（非 JSON）が返るので、JSON かつ ok:true のときだけ server とみなす。
 */
export async function detectRuntimeMode(): Promise<RuntimeMode> {
  if (cached) return cached
  if (probe) return probe

  probe = (async (): Promise<RuntimeMode> => {
    try {
      const res = await fetch(apiUrl('api/health'), {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return 'static'
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('application/json')) return 'static'
      const body = (await res.json()) as { ok?: boolean }
      return body?.ok ? 'server' : 'static'
    } catch {
      return 'static'
    }
  })()

  cached = await probe
  probe = null
  return cached
}

/** テスト・モード切替時のリセット */
export function resetRuntimeModeCache(): void {
  cached = null
  probe = null
}
