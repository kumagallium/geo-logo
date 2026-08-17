// 画像先行の設計 API
// GET  /api/image/config — 画像生成器の設定（未設定なら command: null と提案）
// PUT  /api/image/config — 設定の保存（command 空で削除）
// POST /api/image/design — ブリーフ → 絵 → 作図の復元（重いので直列で捌く）

import { Hono } from 'hono'
import { Buffer } from 'node:buffer'
import { randomInt } from 'node:crypto'
import { decodeGray } from '../../core/png.js'
import { reconstruct } from '../../core/reconstruct.js'
import { errorBody } from '../../lib/ai-error-codes.js'
import { generateSymbolImage } from '../../lib/image-agent.js'
import { getImageConfig, setImageConfig, suggestImageCommand } from '../config/image.js'

const app = new Hono()

app.get('/config', (c) => {
  const config = getImageConfig()
  return c.json({
    command: config?.command ?? null,
    size: config?.size ?? 512,
    // 未設定のとき UI が「この Mac ならこれで動く」を一発で入れられるように、
    // サーバー側で環境を見て提案する（mflux の在処はサーバーしか知らない）
    suggestion: suggestImageCommand(),
  })
})

app.put('/config', async (c) => {
  const body = await c.req.json<{ command?: string | null; size?: number }>()
  const command = body.command?.trim()
  try {
    setImageConfig(command ? { command, size: body.size } : null)
  } catch (err) {
    return c.json(errorBody(err), 400)
  }
  return c.json({ message: command ? '画像生成器を設定しました' : '画像生成器を外しました' })
})

/**
 * 生成は 1 件ずつ。
 *
 * ローカルの拡散モデルは 1 プロセスで数 GB を使う（量子化済みでも 6GB、
 * フル精度なら 27GB——並べて走らせた実測で 35GB に達しマシンが固まった）。
 * 候補 4 件が並行で届いても、ここで直列に並べ替える。
 */
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

app.post('/design', async (c) => {
  const body = await c.req.json<{ brief?: string; seed?: number }>().catch(() => null)
  const brief = body?.brief?.trim()
  if (!brief || brief.length > 2000) {
    return c.json({ error: 'brief は 1〜2000 文字の文字列で指定してください' }, 400)
  }
  const config = getImageConfig()
  if (!config) {
    return c.json({ error: '画像生成器が設定されていません', code: 'NO_IMAGE_GENERATOR' }, 409)
  }

  // seed はクライアント指定を優先（再現したいとき用）。無指定は毎回散らす。
  // 拡散モデルは prompt + seed で決定的なので、固定すると「もう一度」が同じ絵になる
  const seed = Number.isInteger(body?.seed) ? (body?.seed as number) : randomInt(1, 1_000_000)

  try {
    const design = await enqueue(async () => {
      const { png } = await generateSymbolImage(brief, {
        provider: 'command',
        modelId: 'command',
        apiKey: '',
        command: config.command,
        size: config.size,
        seed,
      })
      const img = decodeGray(Buffer.from(png))
      // 許容誤差・部品の残し方は CLI（scripts/reconstruct.ts）で当たりを取った値
      return reconstruct(img.gray, img.width, img.height, {
        tolerance: 0.02,
        radii: 8,
        name: brief.slice(0, 40),
      })
    })
    // /api/design と同じ形で返す。クライアントは経路の違いを知らなくていい
    return c.json({ design, attempts: [], model: `画像 (${config.command.split(/\s+/)[0].split('/').pop()})`, seed })
  } catch (err) {
    return c.json(errorBody(err), 502)
  }
})

export default app
