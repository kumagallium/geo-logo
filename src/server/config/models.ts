// 登録済みモデルの永続化（JSON ファイル + Keychain）
//
// Graphium の src/server/config/models.ts を移植。
// サーバーモード: data/models.json に保存する。
// 静的モード（GitHub Pages）ではこのモジュール自体がロードされない
//（API キーはブラウザの localStorage が実体 — features/settings/store.ts）。
//
// GEOLOGO_USE_KEYCHAIN=1 の macOS では、API キーは Keychain に保存し、ファイルには
// metadata のみを書く。旧形式（apiKey をファイルに含む）のデータは初回読み込み時に
// Keychain へ移行し、ファイルから消す。

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { isKeychainEnabled, getApiKey, setApiKey, deleteApiKey } from './keychain.js'
import type { ModelConfig } from '../../lib/model-config.js'

/** ファイルに書く形式。Keychain 有効時は apiKey を含まない */
type StoredModelConfig = Omit<ModelConfig, 'apiKey'> & { apiKey?: string }

let dataDir = join(process.cwd(), 'data')
let migrated = false

/** データディレクトリを設定する（テスト・Docker 用） */
export function setDataDir(dir: string): void {
  dataDir = dir
  // dataDir が変わったら次の読み込みで再度移行を試みる
  migrated = false
}

function modelsPath(): string {
  return join(dataDir, 'models.json')
}

function ensureDataDir(): void {
  if (!existsSync(dataDir)) {
    // 0700: 同一マシンの他ユーザーから読ませない。Keychain 無効時は
    // このファイルが API キーの実体になるため、既定の 0755 では緩すぎる。
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  }
  tighten(dataDir, 0o700)
}

/** 権限を絞る。既に存在するファイル・別環境から持ち込んだファイルにも効かせる。 */
function tighten(path: string, mode: number): void {
  // Windows では chmod がほぼ無効。失敗しても起動は止めない。
  if (process.platform === 'win32') return
  try {
    chmodSync(path, mode)
  } catch (e) {
    console.warn(
      `[models] failed to chmod ${path}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

function readRawStored(): StoredModelConfig[] {
  try {
    const raw = readFileSync(modelsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as StoredModelConfig[]
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    // ENOENT は「まだ保存していない」状態として静かに [] を返す。
    // それ以外（権限エラー / JSON 破損）は黙って [] を返すと「登録したはずの
    // モデルが消えた」というサイレント故障になるので、必ず warn を残す。
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'ENOENT') {
      console.warn(
        `[models] failed to read ${modelsPath()} (code=${code ?? '?'}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    return []
  }
}

function writeRawStored(models: StoredModelConfig[]): void {
  ensureDataDir()
  // mode は新規作成時にしか効かないので、既存ファイルにも chmod をかけ直す
  writeFileSync(modelsPath(), JSON.stringify(models, null, 2), { encoding: 'utf-8', mode: 0o600 })
  tighten(modelsPath(), 0o600)
}

/**
 * 旧形式（apiKey がファイルに平文で含まれる）から Keychain へ一度だけ移行する。
 * 移行後は apiKey フィールドを除いたファイルを書き戻し、平文を残さない。
 */
function migrateIfNeeded(): void {
  if (migrated || !isKeychainEnabled()) {
    migrated = true
    return
  }
  const stored = readRawStored()
  let changed = false
  for (const m of stored) {
    if (m.apiKey && m.apiKey.length > 0) {
      try {
        setApiKey(m.id, m.apiKey)
        delete m.apiKey
        changed = true
      } catch (e) {
        // 一件失敗しても他のモデルの移行は続行する。失敗したエントリは次回起動で
        // 再試行されるよう、apiKey をそのまま残す（ファイル書き戻し対象外）。
        console.warn(
          `[models] Keychain migration failed for ${m.id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    }
  }
  if (changed) writeRawStored(stored)
  migrated = true
}

/** ストア済みのレコードに Keychain から取得した API キーをマージする */
function hydrate(stored: StoredModelConfig[]): ModelConfig[] {
  if (isKeychainEnabled()) {
    return stored.map((m) => ({ ...m, apiKey: getApiKey(m.id) ?? m.apiKey ?? '' }))
  }
  return stored.map((m) => ({ ...m, apiKey: m.apiKey ?? '' }))
}

function readModels(): ModelConfig[] {
  migrateIfNeeded()
  return hydrate(readRawStored())
}

export function listModels(): ModelConfig[] {
  return readModels()
}

export function getModel(id: string): ModelConfig | undefined {
  return readModels().find((m) => m.id === id)
}

export function getModelByName(name: string): ModelConfig | undefined {
  return readModels().find((m) => m.name === name)
}

export function getDefaultModel(): ModelConfig | undefined {
  return readModels()[0]
}

/**
 * 登録はされているが API キーが空文字のモデル一覧を返す。
 *
 * これが空でない状況は事故サインで、想定する典型は:
 *   - Keychain ダウングレード罠: Keychain 有効で起動 → 移行で models.json から
 *     apiKey が消える → Keychain 非対応の環境で起動 → どちらからも読めない
 *   - Keychain エントリ自体が削除された（手動 / 別ユーザーで起動した等）
 *
 * UI 側はこれを見て「保存済みキーが読めない / 再入力してください」の警告を出す。
 */
export function findModelsWithMissingApiKey(): Array<{
  id: string
  name: string
  provider: string
}> {
  return readModels()
    .filter((m) => !m.apiKey)
    .map((m) => ({ id: m.id, name: m.name, provider: m.provider }))
}

export function addModel(input: Omit<ModelConfig, 'id' | 'createdAt'>): ModelConfig {
  migrateIfNeeded()
  const stored = readRawStored()
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  const record: StoredModelConfig = {
    id,
    name: input.name,
    provider: input.provider,
    modelId: input.modelId,
    apiBase: input.apiBase,
    rate: input.rate,
    createdAt,
  }
  if (isKeychainEnabled()) {
    setApiKey(id, input.apiKey)
  } else {
    record.apiKey = input.apiKey
  }
  stored.push(record)
  writeRawStored(stored)
  return { ...input, id, createdAt }
}

export function updateModel(
  id: string,
  input: Partial<Omit<ModelConfig, 'id' | 'createdAt'>>,
): ModelConfig | undefined {
  migrateIfNeeded()
  const stored = readRawStored()
  const idx = stored.findIndex((m) => m.id === id)
  if (idx < 0) return undefined
  const next: StoredModelConfig = { ...stored[idx] }
  if (input.name !== undefined) next.name = input.name
  if (input.provider !== undefined) next.provider = input.provider
  if (input.modelId !== undefined) next.modelId = input.modelId
  if (input.apiBase !== undefined) next.apiBase = input.apiBase
  if (input.rate !== undefined) next.rate = input.rate

  // apiKey 更新（空文字なら既存維持）
  const newKey = input.apiKey ? input.apiKey : undefined

  if (isKeychainEnabled()) {
    if (newKey) setApiKey(id, newKey)
    delete next.apiKey
    stored[idx] = next
    writeRawStored(stored)
    return { ...next, apiKey: getApiKey(id) ?? '' }
  }
  if (newKey) next.apiKey = newKey
  stored[idx] = next
  writeRawStored(stored)
  return { ...next, apiKey: next.apiKey ?? '' }
}

export function removeModel(id: string): boolean {
  migrateIfNeeded()
  const stored = readRawStored()
  const filtered = stored.filter((m) => m.id !== id)
  if (filtered.length === stored.length) return false
  writeRawStored(filtered)
  if (isKeychainEnabled()) deleteApiKey(id)
  return true
}
