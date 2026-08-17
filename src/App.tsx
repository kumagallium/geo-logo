import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  compile,
  designFromReference,
  samples,
  type CompileResult,
  type LogoDesign,
} from './core/index'
import ChatPane from './features/chat/ChatPane'
import HistoryPane from './features/chat/HistoryPane'
import { nextId, type Message, type Session } from './features/chat/types'
import { requestDesigns } from './features/designer/api'
import { Candidates } from './features/designer/Candidates'
import { Inspector } from './features/designer/Inspector'
import { SvgPane } from './features/designer/SvgPane'
import { listModels, type ModelSummary } from './features/settings/model-source'
import { UpdateBanner } from './components/UpdateBanner'
import { SettingsModal } from './features/settings/SettingsModal'
import { initUpdater } from './lib/updater'
import { loadSettings, setAiModelsAvailable } from './features/settings/store'
import { localizeAiError, OPEN_SETTINGS_EVENT } from './lib/ai-error'
import { RUNTIME_MODE_RESET_EVENT, detectRuntimeMode, type RuntimeMode } from './lib/runtime-mode'

/**
 * 左に履歴、中央に設計、右に対話。
 *
 * 参照素材から作図する経路を独立したモードとして見せるのはやめた。それは
 * 道具の内部事情であって、利用者が選ぶことではない。素材を添えるかどうかは
 * 作りたいものによって決まるので、対話に添えるものとして扱う。
 */

const CANDIDATE_COUNT = 4

/** 抽象度と肉付けのつまみ。題材によって必要な抽象度が違うので表に出す。 */
type Shaping = { circles: number; channel: number; taper: boolean; ground: boolean }
const SHAPING: Shaping = { circles: 9, channel: 0, taper: true, ground: true }

function newSession(): Session {
  return { id: nextId('s'), title: '', updatedAt: Date.now(), messages: [], design: null }
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>(() => [newSession()])
  const [activeId, setActiveId] = useState(() => sessions[0].id)
  const [design, setDesign] = useState<LogoDesign>(samples[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<RuntimeMode | null>(null)
  const [models, setModels] = useState<ModelSummary[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 同じブリーフから複数案を出し、人が選ぶ。構図の良否は機械判定できないため。
  const [candidates, setCandidates] = useState<LogoDesign[]>([])
  const [reference, setReference] = useState<{ name: string; svg: string } | null>(null)
  const [shaping, setShaping] = useState<Shaping>(SHAPING)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]

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

  // 同梱サーバーが後から起動したら、モードとモデル一覧を見直す（デスクトップ版）
  useEffect(() => {
    const again = () => void refreshModels()
    window.addEventListener(RUNTIME_MODE_RESET_EVENT, again)
    return () => window.removeEventListener(RUNTIME_MODE_RESET_EVENT, again)
  }, [refreshModels])

  // デスクトップ版だけ、起動時と 24 時間ごとに更新を確認する
  useEffect(() => {
    initUpdater()
  }, [])

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

  const push = useCallback(
    (message: Message, next?: LogoDesign) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId
            ? {
                ...s,
                updatedAt: Date.now(),
                messages: [...s.messages, message],
                design: next ?? s.design,
              }
            : s,
        ),
      )
    },
    [activeId],
  )

  /** 参照が添えられていれば、そこから作図する。無ければ要件から生成する。 */
  const send = useCallback(
    async (text: string) => {
      push({ id: nextId('m'), role: 'user', text, reference: reference?.name })
      setBusy(true)
      setError(null)
      try {
        if (reference) {
          const built = designFromReference(reference.svg, {
            ...shaping,
            name: text.slice(0, 40),
            concept: text,
          })
          if (!built) {
            throw new Error('参照から形を取り出せませんでした（線だけの素材は対象外です）')
          }
          setCandidates([])
          setDesign(built.design)
          push(
            {
              id: nextId('m'),
              role: 'assistant',
              text: `参照から円 ${built.circles.length} 個を取り出し、円弧 ${built.arcs} 本・半径 ${built.radii} 種で作図しました。`,
              design: built.design,
              reference: reference.name,
            },
            built.design,
          )
          return
        }

        const results = await requestDesigns(text, CANDIDATE_COUNT)
        const ok = results.filter((r) => r.ok)
        if (ok.length === 0) {
          // 全滅したときは最初の失敗を見せる（同じ原因のことが多い）
          const first = results.find((r) => !r.ok)
          throw first && !first.ok ? first.error : new Error('設計を生成できませんでした')
        }
        const designs = ok.map((r) => (r.ok ? r.design : samples[0]))
        setCandidates(designs)
        setDesign(designs[0])
        const failed = results.length - ok.length
        push(
          {
            id: nextId('m'),
            role: 'assistant',
            text: `${designs.length} 案を作図しました。${failed > 0 ? `（${failed} 案は幾何の判定で落ちました）` : ''}`,
            design: designs[0],
          },
          designs[0],
        )
      } catch (err) {
        const message = localizeAiError(err)
        setError(message)
        push({ id: nextId('m'), role: 'assistant', text: message })
      } finally {
        setBusy(false)
      }
    },
    [push, reference, shaping],
  )

  // 参照が付いているときは、つまみを変えるたびに引き直す
  useEffect(() => {
    if (!reference) return
    const built = designFromReference(reference.svg, shaping)
    if (built) setDesign(built.design)
  }, [reference, shaping])

  const compiled = 'error' in result ? null : result
  const slug = compiled ? slugify(compiled.design.name) : 'logo'
  const activeModel =
    models.find((m) => m.name === loadSettings().model)?.name ?? models[0]?.name ?? null

  return (
    <div className="shell">
      <HistoryPane
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id)
          const s = sessions.find((x) => x.id === id)
          if (s?.design) setDesign(s.design)
          setCandidates([])
        }}
        onCreate={() => {
          const s = newSession()
          setSessions((prev) => [s, ...prev])
          setActiveId(s.id)
          setDesign(samples[0])
          setCandidates([])
          setReference(null)
        }}
      />

      <main className="canvas">
        <header className="canvas__head">
          <strong>{compiled?.design.name ?? '—'}</strong>
          <div className="canvas__meta">
            <span className="chip">{activeModel ?? 'モデル未設定'}</span>
            <span className="chip">{mode ?? '…'}</span>
            <button type="button" className="btn btn--ghost" onClick={() => setSettingsOpen(true)}>
              AI 設定
            </button>
          </div>
        </header>

        <UpdateBanner />
        {error && <div className="banner banner--error">{error}</div>}
        {'error' in result && <div className="banner banner--error">DSL エラー: {result.error}</div>}

        {reference && (
          <div className="canvas__shaping">
            <label>
              <span>
                抽象度 — 円 {shaping.circles} 個
                <em>
                  {shaping.circles <= 6 ? '紋章寄り' : shaping.circles >= 13 ? '具象寄り' : '中間'}
                </em>
              </span>
              <input
                type="range"
                min={3}
                max={20}
                value={shaping.circles}
                onChange={(e) => setShaping((s) => ({ ...s, circles: Number(e.target.value) }))}
              />
            </label>
            <label>
              <span>白の隙間 {(shaping.channel * 100).toFixed(0)}%</span>
              <input
                type="range"
                min={0}
                max={20}
                value={Math.round(shaping.channel * 100)}
                onChange={(e) => setShaping((s) => ({ ...s, channel: Number(e.target.value) / 100 }))}
              />
            </label>
            <label className="canvas__toggle">
              <input
                type="checkbox"
                checked={shaping.taper}
                onChange={(e) => setShaping((s) => ({ ...s, taper: e.target.checked }))}
              />
              テーパー
            </label>
            <label className="canvas__toggle">
              <input
                type="checkbox"
                checked={shaping.ground}
                onChange={(e) => setShaping((s) => ({ ...s, ground: e.target.checked }))}
              />
              接地
            </label>
          </div>
        )}

        {compiled && (
          <div className="canvas__body">
            <div className="panes">
              {candidates.length > 1 && (
                <Candidates designs={candidates} selected={design} onSelect={setDesign} />
              )}
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
          </div>
        )}
      </main>

      <ChatPane
        messages={active.messages}
        busy={busy}
        reference={reference?.name ?? null}
        onSend={(text) => void send(text)}
        onAttach={(name, svg) => setReference({ name, svg })}
        onDetach={() => setReference(null)}
        onRestore={(m) => {
          if (m.design) setDesign(m.design)
          setCandidates([])
        }}
      />

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
