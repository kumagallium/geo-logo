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

  it('設定の往復（保存 → 取得 → 解除）', async () => {
    expect(getImageConfig()).toBeNull()

    let res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'mygen --seed {seed} --output {out}', size: 512 }),
    })
    expect(res.status).toBe(200)
    expect(getImageConfig()?.command).toContain('{out}')

    res = await app.request('/config')
    const info = (await res.json()) as { command: string | null }
    expect(info.command).toContain('mygen')

    res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '' }),
    })
    expect(res.status).toBe(200)
    expect(getImageConfig()).toBeNull()
  })

  it('{out} の無いコマンドは保存を断る', async () => {
    const res = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'mygen --prompt {prompt}' }),
    })
    expect(res.status).toBe(400)
  })

  it('未設定で design を頼むと、そうと分かる形で断る', async () => {
    const res = await app.request('/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'ゴリラ' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('NO_IMAGE_GENERATOR')
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
