import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeGrayPng } from '../../core/png'
import { setDataDir } from '../config/models'
import { getImageConfig, setImageConfig } from '../config/image'
import app from './image'

/**
 * 画像先行の設計 API。
 *
 * 生成器そのもの（mflux 等）はテストで動かせないので、「{out} へ PNG を書く」
 * 約束だけ守る偽の生成器（cp）で経路を通す。絵 → 復元 → 設計 JSON の配線と、
 * 未設定時の断り方を固定する。
 */

describe('画像先行の設計 API', () => {
  let dir: string
  const savedEnv = process.env.GEOLOGO_IMAGE_COMMAND

  beforeEach(() => {
    delete process.env.GEOLOGO_IMAGE_COMMAND
    dir = mkdtempSync(join(tmpdir(), 'geologo-image-'))
    setDataDir(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedEnv === undefined) delete process.env.GEOLOGO_IMAGE_COMMAND
    else process.env.GEOLOGO_IMAGE_COMMAND = savedEnv
  })

  it('設定の往復（保存 → 取得 → 自動検出へ戻す）', async () => {
    let res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'mygen --seed {seed} --output {out}', size: 512 }),
    })
    expect(res.status).toBe(200)
    expect(getImageConfig()?.command).toContain('{out}')

    res = await app.request('/config')
    const info = (await res.json()) as { command: string | null; source: string }
    expect(info.command).toContain('mygen')
    expect(info.source).toBe('saved')

    // command 無しの PUT は保存を消して自動検出へ戻す
    res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '' }),
    })
    expect(res.status).toBe(200)
    const after = (await (await app.request('/config')).json()) as { source: string }
    // この環境に mflux があれば auto、無ければ none。saved でないことが本質
    expect(['auto', 'none']).toContain(after.source)
  })

  it('OFF は環境変数や自動検出より強い（切ったのに復活しない）', async () => {
    process.env.GEOLOGO_IMAGE_COMMAND = 'envgen --output {out}'
    // env がある状態でも、OFF を書き残せば使わない
    let res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    const info = (await (await app.request('/config')).json()) as {
      command: string | null
      source: string
    }
    expect(info.command).toBeNull()
    expect(info.source).toBe('disabled')

    // design も断られる
    res = await app.request('/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'ゴリラ' }),
    })
    expect(res.status).toBe(409)

    // ON に戻すと env が効く
    await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const back = (await (await app.request('/config')).json()) as { source: string }
    expect(back.source).toBe('env')
  })

  it('{out} の無いコマンドは保存を断る', async () => {
    const res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'mygen --prompt {prompt}' }),
    })
    expect(res.status).toBe(400)
  })

  it('使えない状態で design を頼むと、そうと分かる形で断る', async () => {
    // 「未設定」は環境次第で自動検出に化ける（開発機に mflux がある）ので、
    // OFF を明示して「使えない」を作る。CI でも開発機でも同じ答えになる
    await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    const res = await app.request('/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'ゴリラ' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('NO_IMAGE_GENERATOR')
  })

  it('モデル未登録でコンセプトを頼むと、そうと分かる形で断る', async () => {
    // resolve-model は env にも落ちるので、試験中は env を確実に空にする
    const saved = { ...process.env }
    delete process.env.GEOLOGO_PROVIDER
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    try {
      const res = await app.request('/concepts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief: '知的な熊' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code?: string }
      expect(body.code).toBe('NO_MODEL_REGISTERED')
    } finally {
      process.env = saved
    }
  })

  it('subject と concept が design へ通る（コンセプト経由の形）', { timeout: 30_000 }, async () => {
    const size = 96
    const gray = new Uint8Array(size * size).fill(255)
    for (let y = 24; y < 72; y++) for (let x = 24; x < 72; x++) gray[y * size + x] = 0
    const fixture = join(dir, 'fixture2.png')
    writeFileSync(fixture, encodeGrayPng(gray, size, size))
    setImageConfig({ command: `cp ${fixture} {out}`, size })

    const res = await app.request('/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brief: '知的な熊',
        name: '学究のシルエット',
        subject: 'A solid silhouette of a bear wearing glasses',
        concept: '眼鏡という記号で知性を定義する',
        seed: 3,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      design: { name: string; concept?: string }
    }
    expect(body.design.name).toBe('学究のシルエット')
    expect(body.design.concept).toBe('眼鏡という記号で知性を定義する')
  })

  it('偽の生成器（cp）で 絵 → 設計 が一巡する', { timeout: 30_000 }, async () => {
    // 復元できる最小の「絵」：白地に黒い矩形
    const size = 96
    const gray = new Uint8Array(size * size).fill(255)
    for (let y = 24; y < 72; y++) for (let x = 24; x < 72; x++) gray[y * size + x] = 0
    const fixture = join(dir, 'fixture.png')
    writeFileSync(fixture, encodeGrayPng(gray, size, size))

    setImageConfig({ command: `cp ${fixture} {out}`, size })

    const res = await app.request('/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: '四角いマーク', seed: 7 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      design: { name: string; shapes: unknown[] }
      seed: number
      model: string
    }
    expect(body.design.shapes.length).toBeGreaterThan(0)
    expect(body.seed).toBe(7)
    expect(body.model).toContain('画像')
  })
})
