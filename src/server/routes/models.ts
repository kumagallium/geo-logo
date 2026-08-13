// モデル管理 API（Graphium の src/server/routes/models.ts を移植）
// GET    /api/models            — 一覧
// POST   /api/models            — 追加
// PUT    /api/models/:id        — 更新
// DELETE /api/models/:id        — 削除
// POST   /api/models/available  — プロバイダーのモデル一覧取得

import { Hono } from 'hono'
import {
  listModels,
  addModel,
  updateModel,
  removeModel,
  getDefaultModel,
  getModel,
  findModelsWithMissingApiKey,
} from '../config/models.js'
import { fetchAvailableModels } from '../../lib/provider-models.js'
import { errorBody } from '../../lib/ai-error-codes.js'
import { requiresApiBase } from '../../lib/model-config.js'

const app = new Hono()

// 登録済みモデル一覧。API キーは返さない（クライアントは持つ必要がない）。
app.get('/', (c) => {
  const models = listModels()
  const defaultModel = getDefaultModel()
  return c.json({
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      model_id: m.modelId,
      api_base: m.apiBase ?? '',
      created_at: m.createdAt,
      rate: m.rate
        ? {
            input: m.rate.input,
            output: m.rate.output,
            cache_read: m.rate.cacheRead,
            cache_write: m.rate.cacheWrite,
            currency: m.rate.currency ?? 'usd',
          }
        : undefined,
    })),
    default: defaultModel?.name ?? '',
    missing_api_key: findModelsWithMissingApiKey(),
  })
})

// モデル追加
// source_model_id を指定すると、既存モデルの認証情報（apiKey / apiBase）を再利用する
app.post('/', async (c) => {
  const body = await c.req.json<{
    model_name: string
    provider: string
    model_id: string
    api_key?: string
    api_base?: string
    rate?: RateBody
    source_model_id?: string
  }>()

  let apiKey = body.api_key ?? ''
  let apiBase = body.api_base
  // provider も source から引く。Graphium は body.provider をそのまま使い、
  // クライアントが source の provider を詰め直す前提だった。ここでは source を
  // 正とすることで、クライアントの詰め直し漏れが「別プロバイダーとして保存される」
  // という気付きにくい壊れ方にならないようにする。
  let provider = body.provider
  if (body.source_model_id) {
    const source = getModel(body.source_model_id)
    if (!source) return c.json({ error: 'Source model not found' }, 404)
    apiKey = source.apiKey
    provider = source.provider
    if (apiBase === undefined) apiBase = source.apiBase ?? undefined
  }

  if (!body.model_name || !provider || !body.model_id || !apiKey) {
    return c.json({ error: 'Required fields are missing' }, 400)
  }
  if (requiresApiBase(provider) && !apiBase) {
    return c.json({ error: 'The openai-compatible provider requires an API Base URL' }, 400)
  }

  const model = addModel({
    name: body.model_name,
    provider,
    modelId: body.model_id,
    apiKey,
    apiBase: apiBase ?? null,
    rate: parseRate(body.rate),
  })
  return c.json({ message: `Model '${model.name}' added`, id: model.id }, 201)
})

// モデル更新
app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    model_name?: string
    provider?: string
    model_id?: string
    api_key?: string
    api_base?: string
    rate?: RateBody | null
  }>()

  const updated = updateModel(id, {
    ...(body.model_name ? { name: body.model_name } : {}),
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model_id ? { modelId: body.model_id } : {}),
    ...(body.api_key ? { apiKey: body.api_key } : {}),
    ...(body.api_base !== undefined ? { apiBase: body.api_base || null } : {}),
    ...(body.rate ? { rate: parseRate(body.rate) } : {}),
  })

  if (!updated) return c.json({ error: 'Model not found' }, 404)
  return c.json({ message: `Model '${updated.name}' updated` })
})

// モデル削除
app.delete('/:id', (c) => {
  const id = c.req.param('id')
  if (!removeModel(id)) return c.json({ error: 'Model not found' }, 404)
  return c.json({ message: 'Model deleted' })
})

// プロバイダーのモデル一覧を取得
// source_model_id を指定すると、既存モデルの認証情報を使って取得する
app.post('/available', async (c) => {
  const body = await c.req.json<{
    provider?: string
    api_key?: string
    api_base?: string
    source_model_id?: string
  }>()

  let provider = body.provider ?? ''
  let apiKey = body.api_key ?? ''
  let apiBaseUrl = body.api_base

  if (body.source_model_id) {
    const source = getModel(body.source_model_id)
    if (!source) return c.json({ error: 'Source model not found' }, 404)
    provider = source.provider
    apiKey = source.apiKey
    if (apiBaseUrl === undefined) apiBaseUrl = source.apiBase ?? undefined
  }

  if (!provider || !apiKey) {
    return c.json({ error: 'provider and api_key are required' }, 400)
  }

  try {
    const models = await fetchAvailableModels(provider, apiKey, apiBaseUrl)
    return c.json({ models })
  } catch (err) {
    // fetchAvailableModels 由来の CodedError（INVALID_API_KEY 等）は code を JSON に通す
    return c.json(errorBody(err), 502)
  }
})

type RateBody = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  currency?: 'usd' | 'jpy'
}

function parseRate(rate: RateBody | null | undefined) {
  if (!rate || typeof rate.input !== 'number' || typeof rate.output !== 'number') {
    return undefined
  }
  return {
    input: rate.input,
    output: rate.output,
    cacheRead: rate.cache_read,
    cacheWrite: rate.cache_write,
    currency: rate.currency === 'jpy' ? ('jpy' as const) : ('usd' as const),
  }
}

export default app
