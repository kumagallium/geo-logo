import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  compile,
  designFromReference,
  samples,
  type CompileResult,
  type LogoDesign,
} from './core/index'
import ChatPane from './features/chat/ChatPane'
import HistoryPane from './features/chat/HistoryPane'
import {
  deleteRemoteSession,
  fetchRemoteSessions,
  loadSessions,
  loadSyncedAt,
  mergeSessions,
  putRemoteSession,
  saveSessions,
  saveSyncedAt,
} from './features/chat/session-store'
import { nextId, titleOf, type Message, type Session } from './features/chat/types'
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
import { isTauri, openWorkspaceDir } from './lib/workspace'

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

/** 前回の履歴があればそこから。無ければ空の会話 1 つ */
function initialState(): { sessions: Session[]; activeId: string } {
  const stored = loadSessions()
  if (!stored) {
    const s = newSession()
    return { sessions: [s], activeId: s.id }
  }
  return { sessions: stored.sessions, activeId: stored.activeId ?? stored.sessions[0].id }
}

export default function App() {
  const [initial] = useState(initialState)
  const [sessions, setSessions] = useState<Session[]>(initial.sessions)
  const [activeId, setActiveId] = useState(initial.activeId)
  const [design, setDesign] = useState<LogoDesign>(
    () => initial.sessions.find((s) => s.id === initial.activeId)?.design ?? samples[0],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<RuntimeMode | null>(null)
  const [models, setModels] = useState<ModelSummary[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reference, setReference] = useState<{ name: string; svg: string } | null>(null)
  const [shaping, setShaping] = useState<Shaping>(SHAPING)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]

  // 同じブリーフから複数案を出し、人が選ぶ。構図の良否は機械判定できないため。
  //
  // 候補は**会話ごと**に持つ。画面の状態にすると、別の会話へ移って戻るだけで
  // 消え、並べた意味が無くなる（実測: 4 案を出しても移動して戻ると 1 案）。
  const candidates = active.candidates ?? []
  const setCandidates = useCallback(
    (next: LogoDesign[] | ((prev: LogoDesign[]) => LogoDesign[])) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId
            ? {
                ...s,
                candidates: typeof next === 'function' ? next(s.candidates ?? []) : next,
              }
            : s,
        ),
      )
    },
    [activeId],
  )

  // 履歴の保存先フォルダ（サーバーが居るとき）。画面の隅に示す
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  // サーバーへ書いた版。同じオブジェクトなら書き直さない
  const savedRef = useRef(new Map<string, Session>())
  const syncedRef = useRef(false)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  // 候補 → 生成時の seed。絵の経路では「選んだ候補の seed + 変えた指示」で
  // 構図を保ったまま磨けるので、どの案から磨くかを選択がそのまま伝える
  const seedByDesign = useRef(new WeakMap<LogoDesign, number>())

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

  // 履歴は変わるたびに localStorage へ書く。静的配信ではこれが実体、
  // サーバーが居る環境では起動直後のキャッシュ（session-store.ts 冒頭）
  useEffect(() => {
    saveSessions(sessions, activeId)
  }, [sessions, activeId])

  // サーバーが居ると分かったら、フォルダの履歴と突き合わせる（1 回だけ）。
  // デスクトップ版は同梱サーバーが後から起動するので、mode が後から server に
  // なる。その時点で走る
  useEffect(() => {
    if (mode !== 'server' || syncedRef.current) return
    let cancelled = false
    void (async () => {
      try {
        const { dir, sessions: remote } = await fetchRemoteSessions()
        if (cancelled) return
        const outcome = mergeSessions(sessionsRef.current, remote, loadSyncedAt())
        let merged = outcome.sessions
        const { toUpload } = outcome
        const uploading = new Set(toUpload.map((s) => s.id))
        for (const s of merged) if (!uploading.has(s.id)) savedRef.current.set(s.id, s)
        syncedRef.current = true
        setWorkspaceDir(dir)
        // 起動直後の空の殻を選んだまま、フォルダの会話が届いたなら、殻は捨てて
        // 直近の会話に居る（起動して最初に見るのは前回の続きであってほしい）
        const current = sessionsRef.current.find((s) => s.id === activeId)
        const newest = merged.find((s) => s.messages.length > 0)
        let nextActive = merged.find((s) => s.id === activeId) ?? merged[0]
        if (current && current.messages.length === 0 && newest) {
          merged = merged.filter((s) => s.id !== current.id)
          nextActive = newest
        }
        // 全部が消えていた（フォルダを空にした等）ら、空の会話を 1 つ置く
        if (merged.length === 0) {
          merged = [newSession()]
          nextActive = merged[0]
        }
        setSessions(merged)
        // 選んでいた会話が無くなっていれば先頭へ。設計もその会話のものに
        if (nextActive) {
          setActiveId(nextActive.id)
          if (nextActive.id !== activeId || design === samples[0]) {
            setDesign(nextActive.design ?? samples[0])
          }
        }
        // 拾い上げたローカル分は savedRef に無いので、下の効果が書きに行く。
        // 送るものが無ければここで同期済みの印を付ける（送るものがあるときは
        // 書けてから付ける——先に付けると、失敗した分が次回「古い」扱いで消える）
        if (toUpload.length === 0) saveSyncedAt(Date.now())
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
    // activeId / design は同期の起点でだけ見る。変わるたびに同期し直さない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // 突き合わせが済んだ後は、変わった会話だけをファイルへ書く
  useEffect(() => {
    if (!syncedRef.current) return
    const dirty = sessions.filter(
      (s) => s.messages.length > 0 && savedRef.current.get(s.id) !== s,
    )
    if (dirty.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        for (const s of dirty) {
          try {
            await putRemoteSession(s)
            if (!cancelled) savedRef.current.set(s.id, s)
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err))
            return
          }
        }
        saveSyncedAt(Date.now())
      })()
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessions])

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

        // 会話はブラッシュアップとして扱う。最新の一言だけを渡すと文脈が
        // 消え、「シルバーバック感を出して」だけでは何の絵かも分からなくなる
        // （実測: 利用者が毎回「ゴリラは維持しつつ」と書き足すはめになった）。
        // このセッションでの依頼を古い順に積んだものをブリーフにする。
        const history = active.messages.filter((m) => m.role === 'user').map((m) => m.text)
        const brief = [...history, text].join('。\n')
        const name = (history[0] ?? text).slice(0, 40)
        // 磨く起点は「いま選んでいる候補」。その seed を 1 件目へ引き継ぐ
        const baseSeed = seedByDesign.current.get(design)

        // できた候補から順に見せる。絵の経路は 1 件 30 秒級なので、全部を
        // 待ってから出すと数分間なにも起きない画面になる
        setCandidates([])
        let firstArrival = true
        const results = await requestDesigns(brief, CANDIDATE_COUNT, {
          baseSeed,
          name: baseSeed === undefined ? name : design.name,
          // 磨くときはコンセプトを引き直さないので、選んだ案の意図を持ち越す。
          // 渡さないとレポートが「画像から復元した作図」の既定文に戻る
          ...(baseSeed === undefined ? {} : { concept: design.concept }),
          onCandidate: (r) => {
            if (!r.ok) return
            if (r.seed !== undefined) seedByDesign.current.set(r.design, r.seed)
            setCandidates((prev) => [...prev, r.design])
            if (firstArrival) {
              firstArrival = false
              setDesign(r.design)
            }
          },
        })
        const ok = results.filter((r) => r.ok)
        if (ok.length === 0) {
          // 全滅したときは最初の失敗を見せる（同じ原因のことが多い）
          const first = results.find((r) => !r.ok)
          throw first && !first.ok ? first.error : new Error('設計を生成できませんでした')
        }
        const designs = ok.map((r) => (r.ok ? r.design : samples[0]))
        setCandidates(designs)
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
    [push, reference, shaping, active.messages, design],
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
        storagePath={workspaceDir}
        onOpenStorage={
          isTauri()
            ? () =>
                void openWorkspaceDir().catch((err) =>
                  setError(err instanceof Error ? err.message : String(err)),
                )
            : undefined
        }
        onDelete={(id) => {
          const target = sessions.find((s) => s.id === id)
          if (!target) return
          // 未着手の会話にはファイルが無い。失うものが無いので確認も要らない
          const saved = target.messages.length > 0
          if (saved && !window.confirm(`「${titleOf(target)}」を削除しますか？ファイルも消えます。`)) {
            return
          }
          const rest = sessions.filter((s) => s.id !== id)
          const next = rest.length > 0 ? rest : [newSession()]
          setSessions(next)
          savedRef.current.delete(id)
          if (id === activeId) {
            const s = next[0]
            setActiveId(s.id)
            setDesign(s.design ?? samples[0])
          }
          if (saved && syncedRef.current) {
            void deleteRemoteSession(id).catch((err) =>
              setError(err instanceof Error ? err.message : String(err)),
            )
          }
        }}
        onSelect={(id) => {
          setActiveId(id)
          const s = sessions.find((x) => x.id === id)
          if (s?.design) setDesign(s.design)
          // 候補はセッション側に居るので、ここで触らない（触ると移動先の案が消える）
        }}
        onCreate={() => {
          // 未着手の会話が既にあるならそこへ行く。押すたびに空の殻が積み上がると、
          // 同じ「新しい設計」が何本も並んで見分けがつかなくなる（実測で 2 本並んだ）
          const blank = sessions.find((s) => s.messages.length === 0)
          const s = blank ?? newSession()
          if (!blank) setSessions((prev) => [s, ...prev])
          setActiveId(s.id)
          setDesign(samples[0])
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
              設定
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
              {/* 納品物は「元の絵 ＋ 作図シート」。復元したベクタで元の絵を
                  置き換えない——復元は元の絵を超えないので（素直なベクタ化に
                  忠実度で 2〜5% 負ける）、置き換えるだけ損になる */}
              {compiled.design.source ? (
                <section className="pane">
                  <header className="pane__head">
                    <div>
                      <h2>元の絵</h2>
                      <p className="pane__sub">これが納品物。作図シートはこの読み取り</p>
                    </div>
                    <a className="btn btn--ghost" href={compiled.design.source} download={`${slug}.png`}>
                      PNG を保存
                    </a>
                  </header>
                  <div className="pane__canvas">
                    <img className="pane__raster" src={compiled.design.source} alt="元の絵" />
                  </div>
                </section>
              ) : (
                <SvgPane
                  title="完成ロゴ"
                  subtitle={`${compiled.built.parts.length} パーツ / ${compiled.design.module}px per module`}
                  svg={compiled.logoSvg}
                  filename={`${slug}.svg`}
                />
              )}
              <SvgPane
                title="作図シート"
                subtitle="元の絵を読み取って起こした作図。寸法はレポートの計測どおり"
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
