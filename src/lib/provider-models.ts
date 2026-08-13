// プロバイダー API からモデル一覧を取得する
//
// Graphium の src/server/services/llm.ts の fetchAvailableModels 系を移植。
// geo-logo では静的モードでもモデル一覧を引けるよう、サーバー専用ではなく
// クライアント・サーバー共有モジュールにしてある（fetch のみ使用）。

import { CodedError } from './ai-error-codes'

const DEFAULT_API_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  groq: 'https://api.groq.com/openai/v1',
}

type ModelFetcher = (apiBase: string, apiKey: string) => Promise<string[]>

/**
 * API キーでプロバイダーのモデル一覧を取得する
 */
export async function fetchAvailableModels(
  provider: string,
  apiKey: string,
  apiBase?: string,
): Promise<string[]> {
  const base = apiBase || DEFAULT_API_BASE[provider]
  if (!base) {
    throw new Error(`${provider} requires an API Base URL`)
  }
  const fetcher = PROVIDER_FETCHER[provider] ?? fetchOpenAIModels
  return fetcher(base, apiKey)
}

const PROVIDER_FETCHER: Record<string, ModelFetcher> = {
  anthropic: fetchAnthropicModels,
  google: fetchGoogleModels,
  // openai, groq, ollama は OpenAI 互換
}

const isBrowser = (): boolean => typeof window !== 'undefined'

async function fetchOpenAIModels(apiBase: string, apiKey: string): Promise<string[]> {
  const url = `${apiBase.replace(/\/$/, '')}/models`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw await formatApiError(res)
  const data = (await res.json()) as { data?: { id: string }[] }
  return (data.data ?? []).map((m) => m.id).sort()
}

async function fetchAnthropicModels(apiBase: string, apiKey: string): Promise<string[]> {
  const url = `${apiBase.replace(/\/$/, '')}/v1/models`
  const all: string[] = []
  const params = new URLSearchParams({ limit: '100' })

  for (;;) {
    const res = await fetch(`${url}?${params}`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // ブラウザ直叩きの明示許可（サーバー経由では不要だが送っても無害）
        ...(isBrowser() ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
      },
    })
    if (!res.ok) throw await formatApiError(res)
    const data = (await res.json()) as {
      data?: { id: string }[]
      has_more?: boolean
      last_id?: string
    }
    all.push(...(data.data ?? []).map((m) => m.id))
    if (!data.has_more) break
    params.set('after_id', data.last_id ?? '')
  }
  return all.sort()
}

async function fetchGoogleModels(apiBase: string, apiKey: string): Promise<string[]> {
  const url = `${apiBase.replace(/\/$/, '')}/v1beta/models`
  const all: string[] = []
  const params = new URLSearchParams({ key: apiKey, pageSize: '100' })

  for (;;) {
    const res = await fetch(`${url}?${params}`)
    if (!res.ok) throw await formatApiError(res)
    const data = (await res.json()) as {
      models?: { name: string; supportedGenerationMethods?: string[] }[]
      nextPageToken?: string
    }
    for (const m of data.models ?? []) {
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue
      const name = m.name.startsWith('models/') ? m.name.slice('models/'.length) : m.name
      if (name) all.push(name)
    }
    if (!data.nextPageToken) break
    params.set('pageToken', data.nextPageToken)
  }
  return all.sort()
}

// プロバイダー API の失敗レスポンスを、code 付き Error（認証系）または素の Error に変換する。
// メッセージは英語フォールバック。表示側は code を日本語文言に置き換える
//（src/lib/ai-error.ts の localizeAiError）。
async function formatApiError(res: Response): Promise<Error> {
  if (res.status === 401) {
    return new CodedError('The API key is invalid.', 'INVALID_API_KEY')
  }
  if (res.status === 403) {
    return new CodedError('The API key does not have permission.', 'API_KEY_FORBIDDEN')
  }
  const text = await res.text().catch(() => '')
  return new Error(`Provider API error (${res.status}): ${text.slice(0, 200)}`)
}
