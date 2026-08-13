// クライアント側 LLM モデル管理（localStorage + セッションメモリ）
//
// Graphium の src/features/settings/store.ts のうち LLM モデル関連を移植したもの。
// Graphium では「Serverless 環境では API キーをサーバーに保存できないため
// クライアントで管理し、リクエストヘッダーで送信する」という位置づけだった。
//
// geo-logo は GitHub Pages で配信されるため、Graphium より一段強い前提を置く:
//
//   ⚠️ `<user>.github.io` は、その利用者の **すべての Pages プロジェクトで
//      オリジンが共通** になる。localStorage はオリジン単位なので、
//      同じアカウントの別リポジトリのページからも読める。
//
// このため既定では API キーを **保存しない**（タブを閉じるまでのメモリ保持）。
// 保存するかどうかはユーザーが明示的に選ぶ。モデルの メタデータ（名前・
// プロバイダー・モデル ID・単価）は保存しても害がないので localStorage に残す。

import type { ModelConfig, TokenRate } from '../../lib/model-config'

const LLM_MODELS_KEY = 'geologo-llm-models'
const SETTINGS_KEY = 'geologo-settings'

/** localStorage に書く形。keyPersisted=false のとき apiKey は含まれない。 */
type StoredModel = Omit<ModelConfig, 'apiKey'> & {
  apiKey?: string
  /** API キーを localStorage に保存したか */
  keyPersisted: boolean
}

/**
 * 保存しないと選ばれたキーの置き場。モジュールスコープなので
 * リロード・タブを閉じた時点で消える。localStorage / sessionStorage には触れない
 *（sessionStorage も同一オリジンの別スクリプトから読めるため）。
 */
const sessionKeys = new Map<string, string>()

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

function readStored(): StoredModel[] {
  try {
    const raw = localStorage.getItem(LLM_MODELS_KEY)
    if (!raw) return []
    const models = JSON.parse(raw) as StoredModel[]
    if (!Array.isArray(models)) return []
    return models.filter((m) => m && typeof m.id === 'string')
  } catch {
    return []
  }
}

function writeStored(models: StoredModel[]): void {
  localStorage.setItem(LLM_MODELS_KEY, JSON.stringify(models))
}

/** 保存済みメタデータに、保存キーまたはセッションキーを合成して返す */
export function getLLMModels(): ModelConfig[] {
  return readStored().map((m) => ({
    ...m,
    apiKey: m.apiKey ?? sessionKeys.get(m.id) ?? '',
  }))
}

/** そのモデルのキーが localStorage に永続化されているか（UI 表示用） */
export function isKeyPersisted(id: string): boolean {
  return readStored().find((m) => m.id === id)?.keyPersisted ?? false
}

/**
 * モデルを追加する。
 * @param persistKey true のときだけ API キーを localStorage に書く。
 *                   既定 (false) はタブを閉じるまでのメモリ保持。
 */
export function addLLMModel(
  input: Omit<ModelConfig, 'id' | 'createdAt'>,
  persistKey = false,
): ModelConfig {
  const models = readStored()
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  const record: StoredModel = {
    id,
    name: input.name,
    provider: input.provider,
    modelId: input.modelId,
    apiBase: input.apiBase,
    rate: input.rate,
    createdAt,
    keyPersisted: persistKey,
  }
  if (persistKey) {
    record.apiKey = input.apiKey
  } else {
    sessionKeys.set(id, input.apiKey)
  }

  models.push(record)
  writeStored(models)
  return { ...input, id, createdAt }
}

/** モデルを更新する（apiKey は空文字なら既存維持 — Graphium の updateModel と同じ規則） */
export function updateLLMModel(
  id: string,
  input: Partial<Omit<ModelConfig, 'id' | 'createdAt'>>,
  persistKey?: boolean,
): ModelConfig | undefined {
  const models = readStored()
  const idx = models.findIndex((m) => m.id === id)
  if (idx < 0) return undefined
  const next: StoredModel = { ...models[idx] }
  if (input.name !== undefined) next.name = input.name
  if (input.provider !== undefined) next.provider = input.provider
  if (input.modelId !== undefined) next.modelId = input.modelId
  if (input.apiBase !== undefined) next.apiBase = input.apiBase
  if (input.rate !== undefined) next.rate = input.rate

  const wantPersist = persistKey ?? next.keyPersisted
  const newKey = input.apiKey || next.apiKey || sessionKeys.get(id) || ''

  next.keyPersisted = wantPersist
  if (wantPersist) {
    next.apiKey = newKey
    sessionKeys.delete(id)
  } else {
    delete next.apiKey
    if (newKey) sessionKeys.set(id, newKey)
  }

  models[idx] = next
  writeStored(models)
  return { ...next, apiKey: newKey }
}

/** クライアントからモデルを削除 */
export function removeLLMModel(id: string): boolean {
  const models = readStored()
  const filtered = models.filter((m) => m.id !== id)
  sessionKeys.delete(id)
  if (filtered.length === models.length) return false
  writeStored(filtered)
  return true
}

/** 保存済みキーだけを消す（メタデータは残す）。「保存をやめる」導線用。 */
export function forgetPersistedKeys(): number {
  const models = readStored()
  let cleared = 0
  for (const m of models) {
    if (m.keyPersisted || m.apiKey) {
      // 消す前にセッションへ移し、その場の作業は続けられるようにする
      if (m.apiKey) sessionKeys.set(m.id, m.apiKey)
      delete m.apiKey
      m.keyPersisted = false
      cleared++
    }
  }
  if (cleared > 0) writeStored(models)
  return cleared
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
