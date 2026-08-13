// モデルレジストリのモード差を吸収する層
//
// サーバーモード: Hono の /api/models（data/models.json + Keychain）が実体。
// 静的モード:     ブラウザの localStorage（store.ts）が実体。
//
// UI はこのモジュールだけを見る。Graphium の設定画面が
// 「Tauri/Node ならサーバー、Web なら localStorage」を分岐していたのと同じ役割。

import { aiErrorFromResponse } from '../../lib/ai-error'
import type { ModelConfig, TokenRate } from '../../lib/model-config'
import { fetchAvailableModels } from '../../lib/provider-models'
import { detectRuntimeMode, type RuntimeMode } from '../../lib/runtime-mode'
import {
  addLLMModel,
  getLLMModels,
  removeLLMModel,
  updateLLMModel,
} from './store'

/** UI に見せるモデル情報。API キーは含まない（サーバーモードでは取得もできない） */
export type ModelSummary = {
  id: string
  name: string
  provider: string
  modelId: string
  apiBase: string | null
  rate?: TokenRate
  createdAt: string
  /** キーが保存されているか。false は「登録済みだが読めない」事故サイン */
  hasApiKey: boolean
}

export type ModelInput = {
  name: string
  provider: string
  modelId: string
  apiKey: string
  apiBase: string | null
  rate?: TokenRate
}

/**
 * 既存モデルの認証情報を再利用して追加する場合の入力。
 *
 * サーバーモードでは API キーがクライアントへ渡らないので、フォームで
 * 「同じキーの別モデル」を作るには id で参照するしかない（Graphium の
 * source_model_id と同じ理由）。静的モードでは localStorage から自前で読む。
 */
export type ModelInputFromSource = Omit<ModelInput, 'apiKey' | 'apiBase'> & {
  sourceModelId: string
  apiBase?: string | null
}

const api = (path: string) => `${import.meta.env.BASE_URL}api${path}`

export async function currentMode(): Promise<RuntimeMode> {
  return detectRuntimeMode()
}

export async function listModels(): Promise<ModelSummary[]> {
  if ((await currentMode()) === 'static') {
    return getLLMModels().map(toSummaryFromLocal)
  }

  const res = await fetch(api('/models'))
  if (!res.ok) throw await aiErrorFromResponse(res, 'モデル一覧の取得に失敗しました')
  const body = (await res.json()) as {
    models: Array<{
      id: string
      name: string
      provider: string
      model_id: string
      api_base: string
      created_at: string
      rate?: {
        input: number
        output: number
        cache_read?: number
        cache_write?: number
        currency?: 'usd' | 'jpy'
      }
    }>
    missing_api_key: Array<{ id: string }>
  }
  const missing = new Set(body.missing_api_key?.map((m) => m.id) ?? [])
  return body.models.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    modelId: m.model_id,
    apiBase: m.api_base || null,
    createdAt: m.created_at,
    hasApiKey: !missing.has(m.id),
    rate: m.rate
      ? {
          input: m.rate.input,
          output: m.rate.output,
          cacheRead: m.rate.cache_read,
          cacheWrite: m.rate.cache_write,
          currency: m.rate.currency ?? 'usd',
        }
      : undefined,
  }))
}

export async function addModel(input: ModelInput): Promise<void> {
  if ((await currentMode()) === 'static') {
    addLLMModel({
      name: input.name,
      provider: input.provider,
      modelId: input.modelId,
      apiKey: input.apiKey,
      apiBase: input.apiBase,
      rate: input.rate,
    })
    return
  }

  const res = await fetch(api('/models'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_name: input.name,
      provider: input.provider,
      model_id: input.modelId,
      api_key: input.apiKey,
      api_base: input.apiBase ?? undefined,
      rate: toRateBody(input.rate),
    }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, 'モデルの追加に失敗しました')
}

/** 既存モデルの認証情報を再利用してモデルを追加する */
export async function addModelFromSource(input: ModelInputFromSource): Promise<void> {
  if ((await currentMode()) === 'static') {
    const source = getLLMModels().find((m) => m.id === input.sourceModelId)
    if (!source) throw new Error('参照元のモデルが見つかりません')
    addLLMModel({
      name: input.name,
      provider: source.provider,
      modelId: input.modelId,
      apiKey: source.apiKey,
      apiBase: input.apiBase !== undefined ? input.apiBase : source.apiBase,
      rate: input.rate,
    })
    return
  }

  const res = await fetch(api('/models'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_name: input.name,
      // provider / api_key はサーバーが source から引くが、契約どおり provider も送る
      provider: input.provider,
      model_id: input.modelId,
      source_model_id: input.sourceModelId,
      ...(input.apiBase !== undefined ? { api_base: input.apiBase ?? '' } : {}),
      rate: toRateBody(input.rate),
    }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, 'モデルの追加に失敗しました')
}

/** 既存モデルの認証情報でプロバイダーのモデル一覧を取得する */
export async function fetchProviderModelsFromSource(sourceModelId: string): Promise<string[]> {
  if ((await currentMode()) === 'static') {
    const source = getLLMModels().find((m) => m.id === sourceModelId)
    if (!source) throw new Error('参照元のモデルが見つかりません')
    return fetchAvailableModels(source.provider, source.apiKey, source.apiBase ?? undefined)
  }

  const res = await fetch(api('/models/available'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_model_id: sourceModelId }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, 'モデル一覧の取得に失敗しました')
  const body = (await res.json()) as { models: string[] }
  return body.models
}

export async function updateModel(id: string, input: Partial<ModelInput>): Promise<void> {
  if ((await currentMode()) === 'static') {
    updateLLMModel(id, input)
    return
  }

  const res = await fetch(api(`/models/${id}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(input.name !== undefined ? { model_name: input.name } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.modelId !== undefined ? { model_id: input.modelId } : {}),
      ...(input.apiKey ? { api_key: input.apiKey } : {}),
      ...(input.apiBase !== undefined ? { api_base: input.apiBase ?? '' } : {}),
      ...(input.rate ? { rate: toRateBody(input.rate) } : {}),
    }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, 'モデルの更新に失敗しました')
}

export async function removeModel(id: string): Promise<void> {
  if ((await currentMode()) === 'static') {
    removeLLMModel(id)
    return
  }
  const res = await fetch(api(`/models/${id}`), { method: 'DELETE' })
  if (!res.ok) throw await aiErrorFromResponse(res, 'モデルの削除に失敗しました')
}

/**
 * プロバイダーのモデル一覧を取得する。
 * サーバーモードではサーバー経由（CORS を踏まない）、静的モードではブラウザから直接。
 */
export async function fetchProviderModels(
  provider: string,
  apiKey: string,
  apiBase?: string,
): Promise<string[]> {
  if ((await currentMode()) === 'static') {
    return fetchAvailableModels(provider, apiKey, apiBase)
  }

  const res = await fetch(api('/models/available'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, api_key: apiKey, api_base: apiBase }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, 'モデル一覧の取得に失敗しました')
  const body = (await res.json()) as { models: string[] }
  return body.models
}

function toSummaryFromLocal(m: ModelConfig): ModelSummary {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    modelId: m.modelId,
    apiBase: m.apiBase,
    rate: m.rate,
    createdAt: m.createdAt,
    hasApiKey: Boolean(m.apiKey),
  }
}

function toRateBody(rate?: TokenRate) {
  if (!rate) return undefined
  return {
    input: rate.input,
    output: rate.output,
    cache_read: rate.cacheRead,
    cache_write: rate.cacheWrite,
    currency: rate.currency ?? 'usd',
  }
}
