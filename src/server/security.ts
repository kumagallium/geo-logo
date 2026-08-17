import type { MiddlewareHandler } from 'hono'

/**
 * ローカル API の CSRF / クロスオリジン保護。
 *
 * このサーバーは登録済みモデルの API キーを保持し、それを使って課金の発生する
 * リクエストを送る。ブラウザから届く以上、利用者が閲覧している **無関係な
 * Web ページ** が `fetch('http://localhost:8787/api/...')` を投げられる点が
 * 問題になる。CORS を開けていなくても、単純リクエスト（GET / フォーム POST）は
 * レスポンスが読めないだけで **副作用は発生する**。
 *
 * そこで送信元を明示的に検査する:
 *   - `Sec-Fetch-Site` があれば same-origin / none 以外を拒否（現行ブラウザ）
 *   - `Origin` があれば許可リストと照合（古いブラウザ・プロキシ経由）
 *   - どちらも無い場合は curl 等の非ブラウザとみなして許可
 *
 * 許可オリジンは既定で localhost の dev / api ポートのみ。別ホストから使う場合は
 * GEOLOGO_ALLOWED_ORIGINS にカンマ区切りで明示する。
 */
/**
 * デスクトップ版の画面の送信元。
 *
 * Tauri は画面を独自スキームで配る（macOS / Linux は tauri://localhost、Windows は
 * http(s)://tauri.localhost）。同梱サーバーは 127.0.0.1 で待つので、画面から見ると
 * **必ず cross-origin** になる。ここを許さないと、サイドカーは健康なのに画面は
 * 「サーバーが居ない＝静的モード」と判定し、ブラウザから直接プロバイダーを叩いて
 * CSP に阻まれる（v0.1.0 / v0.1.1 の実機で "Load failed"）。
 *
 * この origin は OS がアプリ自身にだけ割り当てるものなので、悪意あるページが
 * 名乗ることはできない。Graphium も同じ 3 つを許している。
 */
export const DESKTOP_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const

export function originGuard(apiPort: number, devPort = 5173): MiddlewareHandler {
  const allowed = new Set<string>()
  for (const port of [devPort, apiPort]) {
    allowed.add(`http://localhost:${port}`)
    allowed.add(`http://127.0.0.1:${port}`)
  }
  for (const extra of (process.env.GEOLOGO_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim()
    if (trimmed) allowed.add(trimmed)
  }
  const desktop = new Set<string>(DESKTOP_ORIGINS)

  return async (c, next) => {
    const origin = c.req.header('Origin')

    // デスクトップ版の画面だけは、Sec-Fetch-Site が cross-site でも通す。構造上
    // 必ず cross-site なので、先に Sec-Fetch-Site で切ると必ず落ちる。Origin は
    // ブラウザが付けるもので、ページの側では偽れない。
    // GEOLOGO_ALLOWED_ORIGINS で足した送信元にはこの例外を与えない——別オリジン
    // から使うなら proxy で同一オリジンに載せる、という従来の方針のまま
    if (origin && desktop.has(origin)) {
      await next()
      return
    }

    const site = c.req.header('Sec-Fetch-Site')
    if (site && site !== 'same-origin' && site !== 'none') {
      return c.json(
        { error: `Cross-origin request rejected (Sec-Fetch-Site: ${site})` },
        403,
      )
    }

    if (origin && !allowed.has(origin)) {
      return c.json(
        {
          error: `Origin not allowed: ${origin}. Set GEOLOGO_ALLOWED_ORIGINS to permit it.`,
        },
        403,
      )
    }

    await next()
  }
}

/**
 * レスポンスヘッダーの最低限の固め。
 * このサーバーは JSON しか返さないので、内容の推測（sniffing）も
 * フレーム埋め込みも許す理由がない。
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
}
