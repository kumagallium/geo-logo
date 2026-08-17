import { useCallback, useEffect, useMemo, useState } from 'react'
import { localizeAiError } from '../../lib/ai-error'
import { isTauri } from '../../lib/api-base'
import { checkForUpdates, getAppVersion, type CheckResult } from '../../lib/updater'
import {
  API_BASE_HINTS,
  PROVIDERS,
  requiresApiBase,
  type TokenRate,
} from '../../lib/model-config'
import { lookupModelPrice } from '../../lib/model-pricing'
import { RUNTIME_MODE_RESET_EVENT, type RuntimeMode } from '../../lib/runtime-mode'
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
import { forgetPersistedKeys, loadSettings, saveSettings } from './store'

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
  // 既定は保存しない。github.io は同一アカウントの全 Pages とオリジンを共有するため。
  const [persistKey, setPersistKey] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [m, list] = await Promise.all([currentMode(), listModels()])
      setMode(m)
      setModels(list)
    } catch (err) {
      setError(localizeAiError(err))
    }
  }, [])

  // 開いている間に同梱サーバーが起動したら、モードを見直す（デスクトップ版）
  useEffect(() => {
    if (!open) return
    const again = () => void refresh()
    window.addEventListener(RUNTIME_MODE_RESET_EVENT, again)
    return () => window.removeEventListener(RUNTIME_MODE_RESET_EVENT, again)
  }, [open, refresh])

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
        await addModelFromSource(
          {
            sourceModelId,
            provider: source.provider,
            modelId,
            name,
            rate: buildRate(),
          },
          persistKey,
        )
      } else {
        if (!apiKey.trim()) throw new Error('API キーを入力してください')
        if (requiresApiBase(provider) && !apiBase.trim()) {
          throw new Error('openai-compatible では API Base URL が必須です')
        }
        await addModel(
          {
            name,
            provider,
            modelId,
            apiKey: apiKey.trim(),
            apiBase: apiBase.trim() || null,
            rate: buildRate(),
          },
          persistKey,
        )
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
                — サーバーが無いため、API キーはこのブラウザからプロバイダーへ直接送られます。
                <br />
                既定では<strong>キーを保存しません</strong>（このタブを閉じるまでのメモリ保持）。
                <code>*.github.io</code> は同じアカウントの全 Pages とオリジンを共有するため、
                localStorage に置くと他のページからも読めてしまうためです。
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
                          {mode === 'static'
                            ? // 保存しない設定なら、これは異常ではなく想定どおりの状態。
                              // 「読めません」と出すと不具合に見えるので言い方を変える。
                              'キーはこのタブ限りでした。使うには登録し直してください。'
                            : '保存済みキーが読めません。同じ名前で登録し直してください。'}
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

          {mode === 'static' && (
            <label className="persist">
              <input
                type="checkbox"
                checked={persistKey}
                onChange={(e) => setPersistKey(e.target.checked)}
              />
              <span>
                API キーをこのブラウザに保存する
                <small>
                  チェックしないとタブを閉じた時点で消えます。個人端末で毎回入力したくない
                  場合だけ有効にしてください。
                </small>
              </span>
            </label>
          )}

          <button type="button" className="btn" disabled={busy || !effectiveModelId} onClick={handleAdd}>
            {busy ? '追加中…' : 'このモデルを追加'}
          </button>

          {mode === 'static' && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={async () => {
                const n = forgetPersistedKeys()
                await refresh()
                onModelsChanged()
                setError(
                  n > 0
                    ? `${n} 件の保存済みキーを localStorage から削除しました（このタブでは引き続き使えます）`
                    : '保存済みのキーはありませんでした',
                )
              }}
            >
              保存済みキーを localStorage から削除
            </button>
          )}

          <AboutSection />
        </div>
      </div>
    </div>
  )
}

/**
 * このアプリについて——版と、手での更新確認。
 *
 * デスクトップ版は起動時と 24 時間ごとに自動で確認するが、「いま最新か」を
 * 自分で確かめたいことがある。ブラウザ版では更新の概念が無いので、版だけ出す。
 */
function AboutSection() {
  const [version, setVersion] = useState<string>('…')
  const [result, setResult] = useState<CheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const desktop = isTauri()

  useEffect(() => {
    void getAppVersion().then(setVersion)
  }, [])

  const check = useCallback(async () => {
    setChecking(true)
    setResult(null)
    try {
      setResult(await checkForUpdates())
    } finally {
      setChecking(false)
    }
  }, [])

  const message = (() => {
    if (!result) return null
    switch (result.status) {
      case 'up-to-date':
        return '最新です'
      case 'available':
        return `v${result.version} があります。画面上部の案内から更新できます`
      case 'unsupported':
        return 'ブラウザ版は更新の確認をしません'
      case 'error':
        return `確認できませんでした: ${result.message}`
    }
  })()

  return (
    <>
      <h3>このアプリについて</h3>
      <div className="about">
        <span>
          geo-logo <strong>v{version}</strong>
          {desktop ? '（デスクトップ版）' : '（ブラウザ版）'}
        </span>
        {desktop && (
          <button type="button" className="btn btn--ghost" onClick={check} disabled={checking}>
            {checking ? '確認中…' : '更新を確認'}
          </button>
        )}
        {message && <span className="about__result">{message}</span>}
      </div>
    </>
  )
}
