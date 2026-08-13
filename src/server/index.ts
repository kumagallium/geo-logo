import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { compile, designSchema } from '../core/index.js'
import { designLogo } from '../lib/design-agent.js'
import { createModel } from '../lib/create-model.js'
import { errorBody, noModelRegisteredBody } from '../lib/ai-error-codes.js'
import { resolveModelConfig } from './config/resolve-model.js'
import { listModels } from './config/models.js'
import modelsRoute from './routes/models.js'

const app = new Hono()
app.use('/api/*', cors())

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    mode: 'server',
    registeredModels: listModels().length,
  }),
)

app.route('/api/models', modelsRoute)

const designRequest = z.object({
  brief: z.string().min(1).max(2000),
  /** 設定画面で選んだモデル名。未指定なら既定モデル */
  model: z.string().optional(),
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
    const outcome = await designLogo(parsed.data.brief, createModel(modelConfig))
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

const port = Number(process.env.GEOLOGO_PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`geo-logo api  http://localhost:${info.port}  (${listModels().length} models registered)`)
})
