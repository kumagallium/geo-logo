// Vercel AI SDK マルチプロバイダー LLM ラッパー
//
// Graphium の src/server/services/llm.ts の createModel を移植。
// 相違点は 1 つだけ: geo-logo は GitHub Pages（サーバーなし）でも動かすため、
// この関数はブラウザからも呼ばれる。ブラウザ実行時に必要な CORS 用ヘッダーを
// プロバイダーごとに足している。
//
// copilot-subscription / claude-subscription は移植していない。前者は
// @github/copilot-sdk とローカル CLI の subprocess 起動を必要とし静的配信で
// 動かないため、後者は Anthropic の規約で撤去済みのため。

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { ModelConfig } from './model-config'

const isBrowser = (): boolean => typeof window !== 'undefined'

/**
 * ModelConfig からプロバイダーインスタンスを生成する。
 */
export function createModel(config: ModelConfig): LanguageModel {
  switch (config.provider) {
    case 'anthropic': {
      // `createAnthropic` に baseURL を渡さないと SDK は環境変数 `ANTHROPIC_BASE_URL` を
      // 読み、最終フォールバックで `https://api.anthropic.com/v1` を使う。
      // 環境に `ANTHROPIC_BASE_URL=https://api.anthropic.com`（/v1 なし）が
      // セットされていると、SDK は `${env}/messages` を叩いて 404 を返す。
      // → 環境変数の影響を断ち切るため、常に明示的に baseURL を渡す。
      const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com/v1'
      const normalizedBase = (() => {
        if (!config.apiBase) return ANTHROPIC_DEFAULT_BASE
        const trimmed = config.apiBase.replace(/\/$/, '')
        return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
      })()
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL: normalizedBase,
        // Anthropic API はブラウザからの直叩きを既定で拒否する。静的モードでは
        // このヘッダーで明示的に許可する必要がある（サーバー経由では不要）。
        ...(isBrowser()
          ? { headers: { 'anthropic-dangerous-direct-browser-access': 'true' } }
          : {}),
      })
      return provider(config.modelId)
    }
    case 'openai': {
      // apiBase が設定されている場合は openai-compatible を使う
      // （@ai-sdk/openai は baseURL でカスタムエンドポイントを正しく扱えない場合がある）
      if (config.apiBase) {
        const provider = createOpenAICompatible({
          name: config.name,
          baseURL: config.apiBase,
          apiKey: config.apiKey,
        })
        return provider(config.modelId)
      }
      const provider = createOpenAI({ apiKey: config.apiKey })
      return provider(config.modelId)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({ apiKey: config.apiKey })
      return provider(config.modelId)
    }
    case 'openai-compatible': {
      if (!config.apiBase) {
        throw new Error('The openai-compatible provider requires apiBase')
      }
      const provider = createOpenAICompatible({
        name: config.name,
        baseURL: config.apiBase,
        apiKey: config.apiKey,
      })
      return provider(config.modelId)
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }
}
