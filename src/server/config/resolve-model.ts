// リクエストからモデル設定を解決する
//
// Graphium の src/server/services/header-model.ts を移植し、環境変数フォールバックを足した。
//
// 優先順:
//   1. X-LLM-API-Key ヘッダー（クライアント保持のキーを注入する経路）
//   2. models.json（設定画面から登録したモデル）
//   3. 環境変数（.env の GEOLOGO_PROVIDER / ANTHROPIC_API_KEY など）

import type { Context } from 'hono'
import type { ModelConfig } from '../../lib/model-config.js'
import { getDefaultModel, getModelByName } from './models.js'

/**
 * X-LLM-API-Key ヘッダーからモデル設定を組み立てる。
 * 壊れた JSON は undefined を返し、以降のフォールバックに任せる。
 */
function fromHeader(c: Context): ModelConfig | undefined {
  const raw = c.req.header('X-LLM-API-Key')
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as {
      provider: string
      modelId: string
      apiKey: string
      apiBase?: string | null
      name?: string
      rate?: {
        input?: number
        output?: number
        cacheRead?: number
        cacheWrite?: number
        currency?: 'usd' | 'jpy'
      }
    }
    const rate =
      parsed.rate &&
      typeof parsed.rate.input === 'number' &&
      typeof parsed.rate.output === 'number'
        ? {
            input: parsed.rate.input,
            output: parsed.rate.output,
            cacheRead: parsed.rate.cacheRead,
            cacheWrite: parsed.rate.cacheWrite,
            currency: parsed.rate.currency === 'jpy' ? ('jpy' as const) : ('usd' as const),
          }
        : undefined
    return {
      id: 'header-injected',
      name: parsed.name || parsed.modelId,
      provider: parsed.provider,
      modelId: parsed.modelId,
      apiKey: parsed.apiKey,
      apiBase: parsed.apiBase ?? null,
      rate,
      createdAt: new Date().toISOString(),
    }
  } catch {
    return undefined
  }
}

/**
 * .env ベースのフォールバック。設定画面を使わずに動かしたいときの経路で、
 * 従来の GEOLOGO_PROVIDER / GEOLOGO_MODEL / ANTHROPIC_API_KEY をそのまま読む。
 */
export function fromEnv(): ModelConfig | undefined {
  const provider = (process.env.GEOLOGO_PROVIDER ?? 'anthropic').toLowerCase()

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return undefined
    return {
      id: 'env',
      name: `env:${process.env.GEOLOGO_MODEL ?? 'claude-opus-5'}`,
      provider: 'anthropic',
      modelId: process.env.GEOLOGO_MODEL ?? 'claude-opus-5',
      apiKey,
      apiBase: process.env.GEOLOGO_BASE_URL ?? null,
      createdAt: new Date().toISOString(),
    }
  }

  const baseURL = process.env.GEOLOGO_BASE_URL
  if (!baseURL) return undefined
  return {
    id: 'env',
    name: `env:${process.env.GEOLOGO_MODEL ?? 'gpt-oss-120b'}`,
    provider: 'openai-compatible',
    modelId: process.env.GEOLOGO_MODEL ?? 'gpt-oss-120b',
    apiKey: process.env.GEOLOGO_API_KEY ?? '',
    apiBase: baseURL,
    createdAt: new Date().toISOString(),
  }
}

/**
 * リクエストからモデル設定を解決する。
 *
 * modelName 指定があるのに見つからない場合、getDefaultModel()（= 登録配列の先頭）へ
 * 黙ってフォールバックすると、ユーザーが選んだのとは別の provider / 課金モデルで実行され、
 * 意図しない課金や認証エラーにつながる。解決できないことを明示するため undefined を返す。
 */
export function resolveModelConfig(
  c: Context,
  options?: { modelName?: string },
): ModelConfig | undefined {
  const header = fromHeader(c)
  if (header) return header

  if (options?.modelName) {
    const found = getModelByName(options.modelName)
    if (!found) {
      console.warn(
        `[resolve-model] requested model "${options.modelName}" not found; refusing silent fallback to default model`,
      )
      return undefined
    }
    return found
  }

  return getDefaultModel() ?? fromEnv()
}
