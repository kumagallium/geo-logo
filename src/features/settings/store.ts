// クライアント側 LLM モデル管理（localStorage）
//
// Graphium の src/features/settings/store.ts のうち LLM モデル関連を移植したもの。
// Graphium では「Vercel 等の Serverless 環境では API キーをサーバーに保存できないため
// クライアントで管理し、リクエストヘッダーで送信する」という位置づけだった。
// geo-logo の静的モード（GitHub Pages）も同じ理由でこちらを実体にする。
//
// ⚠️ 静的モードでは API キーが localStorage に平文で入り、ブラウザから
//    プロバイダーへ直接送られる。利用者自身の端末・自身のキーに閉じるが、
//    共用端末では使わないこと。サーバーモードでは Keychain / data 配下に保存される。

import type { ModelConfig, TokenRate } from '../../lib/model-config'

const LLM_MODELS_KEY = 'geologo-llm-models'
const SETTINGS_KEY = 'geologo-settings'

export type Settings = {
  /** 使用するモデル名（空文字 = 登録配列の先頭） */
  model: string
  /** 使用量表示に使う通貨 */
  displayCurrency: 'usd' | 'jpy'
}

const DEFAULT_SETTINGS: Settings = {
  model: '',
  displayCurrency: 'usd',
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      model: typeof parsed.model === 'string' ? parsed.model : '',
      displayCurrency: parsed.displayCurrency === 'jpy' ? 'jpy' : 'usd',
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(next: Partial<Settings>): Settings {
  const merged = { ...loadSettings(), ...next }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged))
  } catch {
    // プライベートモード等で書けない場合はメモリ上の値だけで続行する
  }
  return merged
}

export function getSelectedModelName(): string {
  return loadSettings().model
}

// --- モデルレジストリ ---

/** localStorage 保存のモデル一覧を取得 */
export function getLLMModels(): ModelConfig[] {
  try {
    const raw = localStorage.getItem(LLM_MODELS_KEY)
    if (!raw) return []
    const models = JSON.parse(raw) as ModelConfig[]
    if (!Array.isArray(models)) return []
    return models.filter((m) => m && typeof m.id === 'string')
  } catch {
    return []
  }
}

function writeLLMModels(models: ModelConfig[]): void {
  localStorage.setItem(LLM_MODELS_KEY, JSON.stringify(models))
}

/** クライアントにモデルを保存 */
export function addLLMModel(input: Omit<ModelConfig, 'id' | 'createdAt'>): ModelConfig {
  const models = getLLMModels()
  const created: ModelConfig = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }
  models.push(created)
  writeLLMModels(models)
  return created
}

/** モデルを更新する（apiKey は空文字なら既存維持 — Graphium の updateModel と同じ規則） */
export function updateLLMModel(
  id: string,
  input: Partial<Omit<ModelConfig, 'id' | 'createdAt'>>,
): ModelConfig | undefined {
  const models = getLLMModels()
  const idx = models.findIndex((m) => m.id === id)
  if (idx < 0) return undefined
  const next: ModelConfig = { ...models[idx] }
  if (input.name !== undefined) next.name = input.name
  if (input.provider !== undefined) next.provider = input.provider
  if (input.modelId !== undefined) next.modelId = input.modelId
  if (input.apiBase !== undefined) next.apiBase = input.apiBase
  if (input.rate !== undefined) next.rate = input.rate
  if (input.apiKey) next.apiKey = input.apiKey
  models[idx] = next
  writeLLMModels(models)
  return next
}

/** クライアントからモデルを削除 */
export function removeLLMModel(id: string): boolean {
  const models = getLLMModels()
  const filtered = models.filter((m) => m.id !== id)
  if (filtered.length === models.length) return false
  writeLLMModels(filtered)
  return true
}

/**
 * 使用するモデルを取得する。
 * settings.model で名前指定されていればそれを優先し、無ければ先頭を返す。
 */
export function getDefaultLLMModel(): ModelConfig | undefined {
  const models = getLLMModels()
  if (models.length === 0) return undefined
  const name = loadSettings().model
  if (name) {
    const found = models.find((m) => m.name === name)
    if (found) return found
  }
  return models[0]
}

// --- AI 利用可否のキャッシュ ---
//
// Graphium と同じ設計: サーバーモードでは models.json、静的モードでは localStorage が
// 実体で、いずれも非同期に数える必要があるため、起動時チェックが結果をここへ書き込み、
// 同期関数の isAgentConfigured() が読む。
// 既定 true = 楽観的（チェック未了の一瞬に、設定済みユーザーを誤ってブロックしないため）。
let _aiModelsAvailable = true

export function setAiModelsAvailable(hasModels: boolean): void {
  _aiModelsAvailable = hasModels
}

export function isAgentConfigured(): boolean {
  return _aiModelsAvailable
}

export type { ModelConfig, TokenRate }
