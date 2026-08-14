import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { compile, designSchema } from '../core/index.js'
import { designLogo, modeForVariant } from '../lib/design-agent.js'
import { createModel } from '../lib/create-model.js'
import { errorBody, noModelRegisteredBody } from '../lib/ai-error-codes.js'
import { resolveModelConfig } from './config/resolve-model.js'
import { listModels } from './config/models.js'
import modelsRoute from './routes/models.js'
import { originGuard, securityHeaders } from './security.js'

const port = Number(process.env.GEOLOGO_PORT ?? 8787)

/** デスクトップ版のアプリ本体が渡すバージョン。単体起動なら dev。 */
const appVersion = process.env.GEOLOGO_APP_VERSION ?? 'dev'

/**
 * 親プロセスを監視し、消えたら自決する。
 *
 * Tauri のサイドカーとして起動したとき、アプリ本体が終了してもこのプロセスが
 * 残るとポートを握り続ける。次の起動で新しいアプリが古いサーバーを再利用して
 * しまい、後から追加した API が 404 になる（Graphium が実際に踏んだ事故）。
 *
 * signal 0 は存在確認だけでシグナルを送らない。macOS / Linux / Windows の
 * いずれでも Node が対応している。
 */
function startParentWatchdog(): void {
  const parentPid = Number(process.env.GEOLOGO_PARENT_PID)
  if (!Number.isInteger(parentPid) || parentPid <= 0) return

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      console.error(`[sidecar] 親プロセス ${parentPid} が消えました。終了します`)
      process.exit(0)
    }
  }, 2000)
  // watchdog 単独ではイベントループを延命させない
  timer.unref()
}

startParentWatchdog()

const app = new Hono()

// CORS は張らない。ブラウザからは Vite の proxy 経由で同一オリジンとして届くため
// 不要で、開けると任意のサイトからこのローカル API を叩けるようになる。
// 代わりに送信元を検査する。
app.use('/api/*', securityHeaders)
app.use('/api/*', originGuard(port))

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    mode: 'server',
    registeredModels: listModels().length,
    // pid と version はデスクトップ版の整合性検査に使う。自動更新の直後、
    // 古いサイドカーが生き残っていると版が食い違うので、フロントが検知して
    // kill → 再起動する。
    pid: process.pid,
    version: appVersion,
  }),
)

app.route('/api/models', modelsRoute)

const designRequest = z.object({
  brief: z.string().min(1).max(2000),
  /** 設定画面で選んだモデル名。未指定なら既定モデル */
  model: z.string().optional(),
  /**
   * 候補の番号。どの構成モードを使うかはこの番号から決まる（modeForVariant）。
   * 添字で受けるので、範囲外の値も剰余で必ず既存のモードに落ちる。
   */
  variantIndex: z.number().int().min(0).max(999).optional(),
})

app.post('/api/design', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = designRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'brief は 1〜2000 文字の文字列で指定してください' }, 400)
  }

  const modelConfig = resolveModelConfig(c, { modelName: parsed.data.model })
  if (!modelConfig) {
    return c.json(noModelRegisteredBody(), 400)
  }

  try {
    const { variantIndex } = parsed.data
    const outcome = await designLogo(
      parsed.data.brief,
      createModel(modelConfig),
      variantIndex === undefined ? undefined : modeForVariant(variantIndex),
    )
    return c.json({
      design: outcome.result.design,
      attempts: outcome.attempts,
      model: modelConfig.name,
    })
  } catch (err) {
    console.error('[design]', err)
    return c.json(errorBody(err), 500)
  }
})

/** 手編集した DSL を再コンパイルする（LLM を経由しない） */
app.post('/api/compile', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = designSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'DSL の検証に失敗しました', issues: parsed.error.issues }, 400)
  }
  try {
    const result = compile(parsed.data)
    return c.json({
      design: result.design,
      logoSvg: result.logoSvg,
      blueprintSvg: result.blueprintSvg,
      notes: result.notes,
      warnings: result.warnings,
      constraintErrors: result.constraintErrors,
    })
  } catch (err) {
    console.error('[compile]', err)
    return c.json(errorBody(err), 500)
  }
})

// ループバックのみに束縛する。既定の 0.0.0.0 だと同一 LAN の他端末から
// API キーを使ったリクエストを投げられる。外部公開が必要なら明示的に指定する。
const hostname = process.env.GEOLOGO_HOST ?? '127.0.0.1'

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `geo-logo api  http://${hostname}:${info.port}  (${listModels().length} models registered)`,
  )
})
