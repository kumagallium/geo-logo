// 画像先行の設計 API
// GET  /api/image/config — 画像生成器の設定（未設定なら command: null と提案）
// PUT  /api/image/config — 設定の保存（command 空で削除）
// POST /api/image/design — ブリーフ → 絵 → 作図の復元（重いので直列で捌く）

import { Hono } from 'hono'
import { Buffer } from 'node:buffer'
import { randomInt } from 'node:crypto'
import { decodeGray } from '../../core/png.js'
import { reconstruct } from '../../core/reconstruct.js'
import { errorBody, noModelRegisteredBody } from '../../lib/ai-error-codes.js'
import { generateImageConcepts, refineImageConcept } from '../../lib/concept-agent.js'
import { createModel } from '../../lib/create-model.js'
import { generateSymbolImage } from '../../lib/image-agent.js'
import { resolveModelConfig } from '../config/resolve-model.js'
import {
  getImageConfig,
  resolveImageGen,
  setImageConfig,
  setImageGenEnabled,
} from '../config/image.js'

const app = new Hono()

app.get('/config', (c) => {
  // 使える環境では自動で有効（source: 'auto'）。UI はコマンドを見せる必要が
  // なく、「使えている / いない」と「なぜ」だけ言えればいい
  const { config, source } = resolveImageGen()
  return c.json({
    command: config?.command ?? null,
    size: config?.size ?? 512,
    source,
  })
})

app.put('/config', async (c) => {
  const body = await c.req.json<{ command?: string | null; size?: number; enabled?: boolean }>()
  const command = body.command?.trim()
  try {
    if (command) {
      // 明示コマンド（高度な設定）。自動検出より優先される
      setImageConfig({ command, size: body.size })
    } else if (typeof body.enabled === 'boolean') {
      // ON/OFF。ON は自動検出へ戻し、OFF は「切った」を書き残す
      setImageGenEnabled(body.enabled)
    } else {
      setImageGenEnabled(true) // 保存の取り消し＝自動検出へ
    }
  } catch (err) {
    return c.json(errorBody(err), 400)
  }
  const { source } = resolveImageGen()
  return c.json({ message: '画像生成の設定を更新しました', source })
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

/**
 * ブリーフからコンセプト仮説を出す（言語モデル）。
 *
 * 候補を seed だけで散らすと解釈が 1 つに固定される。ここで比喩の選択を
 * 数案に割り、クライアントは案ごとに /design を叩く。モデル未登録なら
 * 404 相当を返し、クライアントは seed 散らしへ落ちる。
 */
app.post('/concepts', async (c) => {
  const body = await c.req.json<{ brief?: string; count?: number }>().catch(() => null)
  const brief = body?.brief?.trim()
  if (!brief || brief.length > 2000) {
    return c.json({ error: 'brief は 1〜2000 文字の文字列で指定してください' }, 400)
  }
  const count = Math.min(Math.max(Math.trunc(body?.count ?? 4), 2), 6)
  const modelConfig = resolveModelConfig(c, {})
  if (!modelConfig) return c.json(noModelRegisteredBody(), 400)
  try {
    const concepts = await generateImageConcepts(brief, createModel(modelConfig), count)
    return c.json({ concepts, model: modelConfig.name })
  } catch (err) {
    return c.json(errorBody(err), 502)
  }
})

app.post('/design', async (c) => {
  const body = await c.req
    .json<{
      brief?: string
      seed?: number
      name?: string
      subject?: string
      concept?: string
      brush?: boolean
      symmetry?: 'mirror' | 'free'
      previousVisual?: string
      instruction?: string
    }>()
    .catch(() => null)
  const brief = body?.brief?.trim()
  if (!brief || brief.length > 2000) {
    return c.json({ error: 'brief は 1〜2000 文字の文字列で指定してください' }, 400)
  }
  // ブラッシュアップでは brief が会話の累積になり長くなる。名前は最初の
  // 依頼（クライアントが渡す）を使い、題名が指示文の羅列にならないようにする
  const name = body?.name?.trim() || brief
  // コンセプト経由なら、絵の主題は案の視覚記述（英語）を使う。
  // rationale は design.concept に載り、レポートで「狙い」が読める
  let subject = body?.subject?.trim() || brief
  const rationale = body?.concept?.trim()

  // subject が届いていない（＝ブラッシュアップで、選んだ案の視覚記述と直近の
  // 指示が渡された）なら、言語モデルに視覚記述を書き直させる。
  //
  // ここをやらないと subject は brief（会話履歴を積んだ生の日本語文）へ
  // フォールバックし、往復するたびに肥大化する文字列が英語のプロンプト
  // テンプレートへそのまま埋め込まれる。実測でこれが「指示が効かない」の
  // 正体だった——モデルが受け取るのは焦点の合った指示ではなく、薄まっていく
  // 雑多な文字列になっていた。
  const previousVisual = body?.previousVisual?.trim()
  const instruction = body?.instruction?.trim()
  if (!body?.subject?.trim() && previousVisual && instruction) {
    const modelConfig = resolveModelConfig(c, {})
    if (modelConfig) {
      try {
        subject = await refineImageConcept(previousVisual, instruction, createModel(modelConfig))
      } catch {
        // 書き直しに失敗しても生成自体は止めない。brief へのフォールバックのまま進む
      }
    }
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
      const { png } = await generateSymbolImage(subject, {
        provider: 'command',
        modelId: 'command',
        apiKey: '',
        command: config.command,
        size: config.size,
        seed,
        brush: body?.brush === true,
      })
      const img = decodeGray(Buffer.from(png))
      // 許容誤差 0.008: 0.02 だと彫った眉や V 字の目が丸められ、絵の「切れ」が
      // 消える（実測: 同じ絵で一致 92.4% → 95.4%、頂点 68 → 86 の増で済む）。
      // マークの顔つきが商品なので、DSL が少し重くなるほうを取る
      const brush = body?.brush === true
      const built = reconstruct(img.gray, img.width, img.height, {
        tolerance: 0.008,
        radii: 8,
        name: name.slice(0, 40),
        // 対称にするかは**題材の意味**で決まる。画素から測るだけだと、揃える
        // べきものが数 % のずれで判定に落ち、中途半端な非対称で止まる。
        // コンセプトが mirror と言ったら揃え、free と言ったら測りもしない。
        // 筆致は必ず free——筆の勢いは片側が太く片側が細いことそのもので、
        // 揃えると太細もかすれも消える（実測: 円相が幅の変わらない輪になり、
        // 図形数も 12 → 3 に落ちた）
        ...(brush || body?.symmetry === 'free'
          ? { symmetrize: false as const, symmetry: false as const }
          : body?.symmetry === 'mirror'
            ? { symmetrize: true as const }
            : {}),
        ...(rationale ? { concept: rationale } : {}),
      })
      // 元の絵を設計に同梱する。納品物は「元の絵 ＋ 作図シート」で、
      // 復元したベクタで元の絵を置き換えない
      const source = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
      // 実際に画像モデルへ渡した視覚記述を持ち越す。次にブラッシュアップする
      // ときに、これが無いと会話履歴の生文字列へフォールバックしてしまう
      return { ...built, source, visual: subject, ...(brush ? { freehand: true } : {}) }
    })
    // /api/design と同じ形で返す。クライアントは経路の違いを知らなくていい
    return c.json({ design, attempts: [], model: `画像 (${config.command.split(/\s+/)[0].split('/').pop()})`, seed })
  } catch (err) {
    return c.json(errorBody(err), 502)
  }
})

export default app
