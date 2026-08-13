// モデル設定の共有型（クライアント・サーバー共有 / 依存なし）
//
// Graphium の src/server/config/models.ts (ModelConfig / TokenRate) と
// src/features/settings/store.ts (LLMModelConfig / LLMTokenRate) は同じ形を
// 別々に定義していたが、geo-logo では静的モードとサーバーモードで同一の
// createModel を通すため、型は 1 箇所に集約する。

export type RateCurrency = 'usd' | 'jpy'

/** モデルの 1M トークンあたり単価。使用量のコスト計算に使う。
 *  currency を明示することで、ドル建て（Anthropic / OpenAI）と円建て（さくら AI 等）の
 *  モデルを混在させても表示通貨に換算して合計を出せる。 */
export type TokenRate = {
  /** 入力トークンの単価（1M tokens あたり） */
  input: number
  /** 出力トークンの単価 */
  output: number
  /** prompt caching の読み出し単価。未設定なら input と同じ扱い */
  cacheRead?: number
  /** prompt caching の書き込み単価。未設定なら input と同じ扱い */
  cacheWrite?: number
  /** rate の通貨。未指定なら "usd" 扱い */
  currency?: RateCurrency
}

export type ModelConfig = {
  id: string
  /** 表示名 */
  name: string
  /** プロバイダー識別子 (anthropic, openai, google, openai-compatible) */
  provider: string
  /** プロバイダーのモデル ID (claude-opus-5 等) */
  modelId: string
  /** API キー */
  apiKey: string
  /** カスタム API ベース URL（OpenAI 互換用） */
  apiBase: string | null
  /** トークン単価。未設定ならコスト計算をスキップする。 */
  rate?: TokenRate
  createdAt: string
}

export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'openai-compatible', name: 'OpenAI Compatible (Groq, Ollama, さくら AI Engine 等)' },
] as const

export type ProviderId = (typeof PROVIDERS)[number]['id']

export const API_BASE_HINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  'openai-compatible': 'https://api.example.com/v1',
}

/** そのプロバイダーが API キーを必須とするか */
export function requiresApiKey(provider: string): boolean {
  // Graphium の isSubscriptionProvider に相当する分岐点。
  // geo-logo はサブスク型（copilot-subscription 等）を持たないため常に true。
  return provider !== ''
}

/** openai-compatible は接続先が一意に定まらないので apiBase が必須 */
export function requiresApiBase(provider: string): boolean {
  return provider === 'openai-compatible'
}
