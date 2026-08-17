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
 * リセットのたびに進む世代。飛行中の古い判定が、戻ってきてから新しい判定を
 * 上書きしないためのもの。起動直後は「まだ居ない」判定と「起動した」の合図が
 * 数十 ms の差で並ぶので、順序に頼れない
 */
let generation = 0

/**
 * /api/health に到達できるかで判定する。静的配信では 404 か
 * index.html（非 JSON）が返るので、JSON かつ ok:true のときだけ server とみなす。
 */
export async function detectRuntimeMode(): Promise<RuntimeMode> {
  if (cached) return cached
  if (probe) return probe

  const mine = generation
  const run = (async (): Promise<RuntimeMode> => {
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
  probe = run

  const result = await run
  // 待っている間にリセットされていたら、この判定は古い。書き戻さない
  if (mine === generation) {
    cached = result
    probe = null
  }
  return result
}

/** テスト・モード切替時のリセット */
/** モードの再判定を促すイベント。サイドカーが起動したときなどに飛ぶ */
export const RUNTIME_MODE_RESET_EVENT = 'geo-logo-runtime-mode-reset'

/**
 * 判定をやり直させる。
 *
 * デスクトップ版は同梱サーバーの起動を待たずに画面を描くので、最初の判定は
 * ほぼ必ず「まだ居ない＝静的」になる。起動が済んだらここでキャッシュを捨て、
 * **画面側にも知らせる**。捨てるだけでは誰も見直しに来ない（実測: サイドカーは
 * 健康なのに設定画面が静的モードのまま、ブラウザから直接 API を叩いて CSP に
 * 阻まれ "Load failed" になった）
 */
export function resetRuntimeModeCache(): void {
  cached = null
  probe = null
  generation++
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RUNTIME_MODE_RESET_EVENT))
  }
}
