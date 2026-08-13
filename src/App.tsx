import { useCallback, useEffect, useMemo, useState } from 'react'
import { compile, samples, type CompileResult, type LogoDesign } from './core/index'
import { localizeAiError, OPEN_SETTINGS_EVENT } from './lib/ai-error'
import { detectRuntimeMode, type RuntimeMode } from './lib/runtime-mode'
import { requestDesign } from './features/designer/api'
import { Inspector } from './features/designer/Inspector'
import { PromptBar } from './features/designer/PromptBar'
import { SvgPane } from './features/designer/SvgPane'
import { SettingsModal } from './features/settings/SettingsModal'
import { listModels, type ModelSummary } from './features/settings/model-source'
import { loadSettings, setAiModelsAvailable } from './features/settings/store'

export default function App() {
  const [design, setDesign] = useState<LogoDesign>(samples[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<RuntimeMode | null>(null)
  const [models, setModels] = useState<ModelSummary[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)

  const refreshModels = useCallback(async () => {
    try {
      const [m, list] = await Promise.all([detectRuntimeMode(), listModels()])
      setMode(m)
      setModels(list)
      setAiModelsAvailable(list.length > 0)
    } catch {
      setMode('static')
      setModels([])
      setAiModelsAvailable(false)
    }
  }, [])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  // AI 未設定ガード（lib/ai-error.ts）からの導線を受ける
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener(OPEN_SETTINGS_EVENT, open)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open)
  }, [])

  // コアは同型なので、DSL の編集はサーバを介さず即座に再ビルドできる。
  const result = useMemo<CompileResult | { error: string }>(() => {
    try {
      return compile(design)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }, [design])

  const generate = useCallback(async (brief: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await requestDesign(brief)
      setDesign(res.design)
      const problems = res.attempts.at(-1)?.problems ?? []
      if (problems.length > 0) {
        setError(`幾何に未解決の問題が残っています: ${problems.join(' / ')}`)
      }
    } catch (err) {
      setError(localizeAiError(err))
      setSettingsOpen(true)
    } finally {
      setBusy(false)
    }
  }, [])

  const compiled = 'error' in result ? null : result
  const slug = compiled ? slugify(compiled.design.name) : 'logo'
  const activeModel =
    models.find((m) => m.name === loadSettings().model)?.name ?? models[0]?.name ?? null

  return (
    <div className="app">
      <PromptBar
        busy={busy}
        mode={mode}
        activeModel={activeModel}
        onGenerate={generate}
        onSample={setDesign}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {error && <div className="banner banner--error">{error}</div>}
      {'error' in result && <div className="banner banner--error">DSL エラー: {result.error}</div>}

      {compiled && (
        <main className="workspace">
          <div className="panes">
            <SvgPane
              title="完成ロゴ"
              subtitle={`${compiled.built.parts.length} パーツ / ${compiled.design.module}px per module`}
              svg={compiled.logoSvg}
              filename={`${slug}.svg`}
            />
            <SvgPane
              title="設計図"
              subtitle="完成ロゴとまったく同じ幾何データから描画"
              svg={compiled.blueprintSvg}
              filename={`${slug}-blueprint.svg`}
            />
          </div>
          <Inspector result={compiled} onApply={setDesign} />
        </main>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onModelsChanged={() => void refreshModels()}
      />
    </div>
  )
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'logo'
  )
}
