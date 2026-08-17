import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_MODE_RESET_EVENT,
  detectRuntimeMode,
  resetRuntimeModeCache,
} from './runtime-mode'

/**
 * デスクトップ版は同梱サーバーの起動を待たずに画面を描く。最初の判定は
 * ほぼ必ず「まだ居ない＝静的」になるので、起動後に**見直せる**ことが要る。
 * 実測: 見直しの配線が無く、サイドカーは健康なのに設定画面が静的モードのまま
 * ブラウザから直接 API を叩いて CSP に阻まれ "Load failed" になった。
 */

const healthy = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('実行モードの判定', () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window

  beforeEach(() => {
    // 判定は window のイベントで見直しを知らせるので、最低限の window を置く
    const listeners = new Map<string, Set<(e: Event) => void>>()
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: (t: string, f: (e: Event) => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set())
        listeners.get(t)?.add(f)
      },
      removeEventListener: (t: string, f: (e: Event) => void) => listeners.get(t)?.delete(f),
      dispatchEvent: (e: Event) => {
        listeners.get(e.type)?.forEach((f) => f(e))
        return true
      },
    }
    resetRuntimeModeCache()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    ;(globalThis as { window?: unknown }).window = originalWindow
    resetRuntimeModeCache()
  })

  it('サーバーが居なければ静的、居れば server', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    expect(await detectRuntimeMode()).toBe('static')

    resetRuntimeModeCache()
    globalThis.fetch = vi.fn(async () => healthy()) as typeof fetch
    expect(await detectRuntimeMode()).toBe('server')
  })

  it('一度決めた判定は覚えておく（毎回叩かない）', async () => {
    const f = vi.fn(async () => healthy())
    globalThis.fetch = f as typeof fetch
    await detectRuntimeMode()
    await detectRuntimeMode()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('サイドカーが後から起動したら、判定をやり直せる', async () => {
    // 起動前：繋がらない → 静的
    let up = false
    globalThis.fetch = vi.fn(async () => {
      if (!up) throw new Error('ECONNREFUSED')
      return healthy()
    }) as typeof fetch
    expect(await detectRuntimeMode()).toBe('static')

    // 起動：キャッシュを捨てると、画面側へ「見直せ」の合図が飛ぶ
    const seen = vi.fn()
    window.addEventListener(RUNTIME_MODE_RESET_EVENT, seen)
    up = true
    resetRuntimeModeCache()
    expect(seen).toHaveBeenCalledTimes(1)

    // 見直すと server になる
    expect(await detectRuntimeMode()).toBe('server')
  })

  it('飛行中の古い判定が、新しい判定を上書きしない', async () => {
    // 最初の判定（繋がらない）が長引いている間にサイドカーが起動した、という並び
    let release: () => void = () => {}
    const slowFail = new Promise<never>((_, reject) => {
      release = () => reject(new Error('ECONNREFUSED'))
    })
    let up = false
    globalThis.fetch = vi.fn(async () => {
      if (!up) return slowFail
      return healthy()
    }) as typeof fetch

    const first = detectRuntimeMode() // 飛行中
    up = true
    resetRuntimeModeCache() // 起動の合図
    expect(await detectRuntimeMode()).toBe('server')

    release() // 古い判定がここで戻ってくる
    expect(await first).toBe('static') // 古い呼び出し自身の答えは静的でよい
    expect(await detectRuntimeMode()).toBe('server') // だがキャッシュは上書きされない
  })
})
