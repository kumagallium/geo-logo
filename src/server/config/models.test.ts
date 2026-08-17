import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addModel, listModels, removeModel, setDataDir, updateModel } from './models'

/**
 * モデルの永続化。特に **setDataDir で保存先を差し替えられる**ことを固定する。
 *
 * デスクトップ版はアプリ本体が OS 標準の app_data_dir を GEOLOGO_DATA_DIR で渡し、
 * サーバーは起動時にそれを setDataDir へ入れる。この配線が外れると、既定の
 * `process.cwd()/data` に書きにいき、.app 起動時は cwd が「/」なので `/data` を
 * 作れず、モデル追加だけが 500 になる（一覧・health は読むだけなので通る）。
 * 実測で踏んだこの壊れ方を、保存先が差し替え先に書かれることの確認で防ぐ。
 */

describe('モデルの永続化', () => {
  let dir: string
  const savedKeychain = process.env.GEOLOGO_USE_KEYCHAIN

  beforeEach(() => {
    // Keychain 経路に入ると本物の macOS Keychain を触るので、テストでは必ず切る
    // （切ると apiKey はファイルに入るので、往復もそのまま検証できる）。
    delete process.env.GEOLOGO_USE_KEYCHAIN
    dir = mkdtempSync(join(tmpdir(), 'geologo-models-'))
    setDataDir(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedKeychain === undefined) delete process.env.GEOLOGO_USE_KEYCHAIN
    else process.env.GEOLOGO_USE_KEYCHAIN = savedKeychain
  })

  it('setDataDir で指定した場所に models.json を書く', () => {
    const model = addModel({
      name: 'gemma',
      provider: 'openai-compatible',
      modelId: 'preview/gemma-4-31B-it',
      apiKey: 'sk-test',
      apiBase: 'https://api.ai.sakura.ad.jp/v1',
      rate: { input: 24, output: 96, currency: 'jpy' },
    })

    // 差し替え先にファイルができる（既定の cwd/data ではない）
    const path = join(dir, 'models.json')
    expect(existsSync(path)).toBe(true)

    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ id: string; name: string }>
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].id).toBe(model.id)
    expect(onDisk[0].name).toBe('gemma')

    // 読み戻しても同じ
    const list = listModels()
    expect(list).toHaveLength(1)
    expect(list[0].apiKey).toBe('sk-test')
  })

  it('追加・更新・削除が差し替え先に対して往復する', () => {
    const a = addModel({
      name: 'a',
      provider: 'openai-compatible',
      modelId: 'm-a',
      apiKey: 'k-a',
      apiBase: 'https://example.test/v1',
    })
    addModel({
      name: 'b',
      provider: 'openai-compatible',
      modelId: 'm-b',
      apiKey: 'k-b',
      apiBase: 'https://example.test/v1',
    })
    expect(listModels()).toHaveLength(2)

    const updated = updateModel(a.id, { name: 'a2' })
    expect(updated?.name).toBe('a2')
    expect(listModels().find((m) => m.id === a.id)?.name).toBe('a2')

    expect(removeModel(a.id)).toBe(true)
    expect(listModels()).toHaveLength(1)
    expect(removeModel(a.id)).toBe(false)
  })
})
