import { useCallback, useEffect, useMemo, useState } from 'react'
import { localizeAiError } from '../../lib/ai-error'
import {
  API_BASE_HINTS,
  PROVIDERS,
  requiresApiBase,
  type TokenRate,
} from '../../lib/model-config'
import { lookupModelPrice } from '../../lib/model-pricing'
import type { RuntimeMode } from '../../lib/runtime-mode'
import {
  addModel,
  addModelFromSource,
  currentMode,
  fetchProviderModels,
  fetchProviderModelsFromSource,
  listModels,
  removeModel,
  type ModelSummary,
} from './model-source'
import { loadSettings, saveSettings } from './store'

type Props = {
  open: boolean
  onClose: () => void
  onModelsChanged: () => void
}

type AddMode = 'new-provider' | 'existing-provider'

export function SettingsModal({ open, onClose, onModelsChanged }: Props) {
  const [mode, setMode] = useState<RuntimeMode | null>(null)
  const [models, setModels] = useState<ModelSummary[]>([])
  const [selected, setSelected] = useState(() => loadSettings().model)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 追加フォーム
  const [addMode, setAddMode] = useState<AddMode>('new-provider')
  const [sourceModelId, setSourceModelId] = useState('')
  const [provider, setProvider] = useState<string>('anthropic')
  const [apiBase, setApiBase] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [available, setAvailable] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [pickedModelId, setPickedModelId] = useState('')
  const [customModelId, setCustomModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [rateInput, setRateInput] = useState('')
  const [rateOutput, setRateOutput] = useState('')
  const [rateCurrency, setRateCurrency] = useState<'usd' | 'jpy'>('usd')

  const refresh = useCallback(async () => {
    try {
      const [m, list] = await Promise.all([currentMode(), listModels()])
      setMode(m)
      setModels(list)
    } catch (err) {
      setError(localizeAiError(err))
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const effectiveModelId = customModelId.trim() || pickedModelId
  const knownPrice = useMemo(() => {
    const p = addMode === 'existing-provider'
      ? models.find((m) => m.id === sourceModelId)?.provider
      : provider
    return p && effectiveModelId ? lookupModelPrice(p, effectiveModelId) : null
  }, [addMode, models, sourceModelId, provider, effectiveModelId])

  // プロバイダーやモデルが変わったら、既知価格をプレースホルダとして提示し直す
  useEffect(() => {
    if (knownPrice) {
      setRateInput(String(knownPrice.input))
      setRateOutput(String(knownPrice.output))
      setRateCurrency('usd')
    }
  }, [knownPrice])

  if (!open) return null

  const resetForm = () => {
    setAvailable([])
    setPickedModelId('')
    setCustomModelId('')
    setDisplayName('')
    setRateInput('')
    setRateOutput('')
    setError(null)
  }

  const handleFetch = async () => {
    setFetching(true)
    setError(null)
    try {
      const list =
        addMode === 'existing-provider'
          ? await fetchProviderModelsFromSource(sourceModelId)
          : await fetchProviderModels(provider, apiKey.trim(), apiBase.trim() || undefined)
      setAvailable(list)
      if (list.length > 0) {
        setPickedModelId(list[0])
        setDisplayName(list[0])
      }
    } catch (err) {
      setError(localizeAiError(err))
    } finally {
      setFetching(false)
    }
  }

  const buildRate = (): TokenRate | undefined => {
    const i = Number(rateInput)
    const o = Number(rateOutput)
    if (!Number.isFinite(i) || !Number.isFinite(o) || rateInput === '' || rateOutput === '') {
      return undefined
    }
    return { input: i, output: o, currency: rateCurrency }
  }

  const handleAdd = async () => {
    const modelId = effectiveModelId
    if (!modelId) {
      setError('モデル ID を選択するか入力してください')
      return
    }
    const name = displayName.trim() || modelId
    setBusy(true)
    setError(null)
    try {
      if (addMode === 'existing-provider') {
        const source = models.find((m) => m.id === sourceModelId)
        if (!source) throw new Error('参照元のモデルを選択してください')
        await addModelFromSource({
          sourceModelId,
          provider: source.provider,
          modelId,
          name,
          rate: buildRate(),
        })
      } else {
        if (!apiKey.trim()) throw new Error('API キーを入力してください')
        if (requiresApiBase(provider) && !apiBase.trim()) {
          throw new Error('openai-compatible では API Base URL が必須です')
        }
        await addModel({
          name,
          provider,
          modelId,
          apiKey: apiKey.trim(),
          apiBase: apiBase.trim() || null,
          rate: buildRate(),
        })
      }
      setApiKey('')
      resetForm()
      await refresh()
      onModelsChanged()
    } catch (err) {
      setError(localizeAiError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (id: string, name: string) => {
    if (!confirm(`モデル「${name}」を削除しますか？`)) return
    setBusy(true)
    try {
      await removeModel(id)
      await refresh()
      onModelsChanged()
    } catch (err) {
      setError(localizeAiError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSelect = (name: string) => {
    setSelected(name)
    saveSettings({ model: name })
    onModelsChanged()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="AI 設定">
        <header className="modal__head">
          <h2>AI 設定</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            閉じる
          </button>
        </header>

        <div className="modal__body">
          <div className={mode === 'static' ? 'alert alert--info' : 'alert'}>
            {mode === 'static' ? (
              <>
                <strong>静的モード</strong>
                — サーバーが無いため、API キーはこのブラウザの localStorage
                に保存し、プロバイダーへ直接送信します。共用端末では使わないでください。
              </>
            ) : mode === 'server' ? (
              <>
                <strong>サーバーモード</strong>
                — API キーはサーバー側の <code>data/models.json</code> に保存されます
                （macOS で <code>GEOLOGO_USE_KEYCHAIN=1</code> を設定すると Keychain に移ります）。
              </>
            ) : (
              '実行モードを判定中…'
            )}
          </div>

          {error && <div className="alert alert--warn">{error}</div>}

          <h3>登録済みモデル</h3>
          {models.length === 0 ? (
            <p className="muted">まだ登録がありません。下のフォームから追加してください。</p>
          ) : (
            <ul className="model-list">
              {models.map((m) => (
                <li key={m.id} className="model-list__item">
                  <label className="model-list__pick">
                    <input
                      type="radio"
                      name="active-model"
                      checked={selected ? selected === m.name : models[0]?.id === m.id}
                      onChange={() => handleSelect(m.name)}
                    />
                    <span>
                      <strong>{m.name}</strong>
                      <small>
                        {m.provider} / {m.modelId}
                        {m.apiBase ? ` / ${m.apiBase}` : ''}
                        {m.rate ? ` / ${m.rate.input}·${m.rate.output} ${m.rate.currency ?? 'usd'}` : ''}
                      </small>
                      {!m.hasApiKey && (
                        <small className="model-list__warn">
                          保存済みキーが読めません。同じ名前で登録し直してください。
                        </small>
                      )}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy}
                    onClick={() => handleRemove(m.id, m.name)}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h3>モデルを追加</h3>

          <div className="seg">
            <button
              type="button"
              className={addMode === 'new-provider' ? 'seg__btn seg__btn--on' : 'seg__btn'}
              onClick={() => {
                setAddMode('new-provider')
                resetForm()
              }}
            >
              新しいプロバイダー
            </button>
            <button
              type="button"
              className={addMode === 'existing-provider' ? 'seg__btn seg__btn--on' : 'seg__btn'}
              disabled={models.length === 0}
              onClick={() => {
                setAddMode('existing-provider')
                setSourceModelId(models[0]?.id ?? '')
                resetForm()
              }}
            >
              既存のキーを再利用
            </button>
          </div>

          {addMode === 'existing-provider' ? (
            <label className="field">
              <span>参照するモデル（プロバイダーと API キーを引き継ぎます）</span>
              <select
                value={sourceModelId}
                onChange={(e) => {
                  setSourceModelId(e.target.value)
                  resetForm()
                }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{m.provider}）
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="field">
                <span>プロバイダー</span>
                <select
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value)
                    resetForm()
                  }}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>
                  API Base URL
                  {requiresApiBase(provider) && <em className="required"> *</em>}
                </span>
                <input
                  type="text"
                  value={apiBase}
                  placeholder={API_BASE_HINTS[provider] ?? ''}
                  onChange={(e) => setApiBase(e.target.value)}
                />
              </label>

              <label className="field">
                <span>API キー</span>
                <input
                  type="password"
                  value={apiKey}
                  placeholder="sk-..."
                  autoComplete="off"
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            </>
          )}

          <button
            type="button"
            className="btn"
            disabled={
              fetching ||
              (addMode === 'existing-provider' ? !sourceModelId : !apiKey.trim())
            }
            onClick={handleFetch}
          >
            {fetching ? '取得中…' : 'モデル一覧を取得'}
          </button>

          {available.length > 0 && (
            <label className="field">
              <span>モデル（{available.length} 件）</span>
              <select
                value={pickedModelId}
                onChange={(e) => {
                  setPickedModelId(e.target.value)
                  setDisplayName(e.target.value)
                  setCustomModelId('')
                }}
              >
                {available.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>モデル ID を直接入力（一覧に無い場合）</span>
            <input
              type="text"
              value={customModelId}
              placeholder="claude-opus-5"
              onChange={(e) => {
                setCustomModelId(e.target.value)
                if (e.target.value) setDisplayName(e.target.value)
              }}
            />
          </label>

          <label className="field">
            <span>表示名</span>
            <input
              type="text"
              value={displayName}
              placeholder={effectiveModelId || 'my-model'}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>

          <fieldset className="rate">
            <legend>
              トークン単価（1M トークンあたり・任意）
              {knownPrice && <span className="rate__hint">既知の参考値を入力済み</span>}
            </legend>
            <div className="rate__row">
              <label>
                <span>入力</span>
                <input
                  type="number"
                  step="0.001"
                  value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                />
              </label>
              <label>
                <span>出力</span>
                <input
                  type="number"
                  step="0.001"
                  value={rateOutput}
                  onChange={(e) => setRateOutput(e.target.value)}
                />
              </label>
              <label>
                <span>通貨</span>
                <select
                  value={rateCurrency}
                  onChange={(e) => setRateCurrency(e.target.value === 'jpy' ? 'jpy' : 'usd')}
                >
                  <option value="usd">USD</option>
                  <option value="jpy">JPY</option>
                </select>
              </label>
            </div>
          </fieldset>

          <button type="button" className="btn" disabled={busy || !effectiveModelId} onClick={handleAdd}>
            {busy ? '追加中…' : 'このモデルを追加'}
          </button>
        </div>
      </div>
    </div>
  )
}
