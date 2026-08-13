import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { originGuard, securityHeaders } from './security'

/**
 * ローカル API は API キーを保持し課金リクエストを送るので、
 * 利用者が開いている無関係なサイトから叩かれてはいけない。
 * CORS を張っていなくても単純リクエストの副作用は通るため、送信元を検査する。
 */

function makeApp() {
  const app = new Hono()
  app.use('/api/*', securityHeaders)
  app.use('/api/*', originGuard(8787, 5173))
  app.get('/api/ping', (c) => c.json({ ok: true }))
  app.delete('/api/ping', (c) => c.json({ deleted: true }))
  return app
}

let app: Hono

beforeEach(() => {
  delete process.env.GEOLOGO_ALLOWED_ORIGINS
  app = makeApp()
})

describe('originGuard', () => {
  it('ヘッダーが無いリクエスト（curl 等）は通す', async () => {
    const res = await app.request('/api/ping')
    expect(res.status).toBe(200)
  })

  it('same-origin のブラウザリクエストは通す', async () => {
    const res = await app.request('/api/ping', {
      headers: { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
  })

  it('別サイトからの GET を拒否する', async () => {
    const res = await app.request('/api/ping', {
      headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('別サイトからの DELETE を拒否する（副作用を伴う経路）', async () => {
    const res = await app.request('/api/ping', {
      method: 'DELETE',
      headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('Sec-Fetch-Site が無い古いブラウザでも Origin で弾く', async () => {
    const res = await app.request('/api/ping', {
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('同一サイト内の別オリジン（same-site）も拒否する', async () => {
    const res = await app.request('/api/ping', {
      headers: { 'Sec-Fetch-Site': 'same-site' },
    })
    expect(res.status).toBe(403)
  })

  it('GEOLOGO_ALLOWED_ORIGINS で明示したオリジンは通す', async () => {
    process.env.GEOLOGO_ALLOWED_ORIGINS = 'http://192.168.1.10:5173'
    const scoped = makeApp()
    const res = await scoped.request('/api/ping', {
      headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://192.168.1.10:5173' },
    })
    // Sec-Fetch-Site の検査が先に効くので、明示許可でも cross-site は拒否される。
    // これは意図した挙動 — 別オリジンから使うなら proxy で同一オリジンに載せる。
    expect(res.status).toBe(403)

    const noFetchMetadata = await scoped.request('/api/ping', {
      headers: { Origin: 'http://192.168.1.10:5173' },
    })
    expect(noFetchMetadata.status).toBe(200)
  })
})

describe('securityHeaders', () => {
  it('sniffing とフレーム埋め込みを禁止する', async () => {
    const res = await app.request('/api/ping')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})
