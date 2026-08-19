import { useEffect, useState } from 'react'
import type { CompileResult, LogoDesign } from '../../core/index'

type Props = {
  result: CompileResult
  onApply: (design: LogoDesign) => void
}

const PHI = (1 + Math.sqrt(5)) / 2

function fmt(v: number): string {
  for (let n = -3; n <= 5; n++) {
    if (Math.abs(v - Math.pow(PHI, n)) < 1e-6) {
      return n === 0 ? '1' : n === 1 ? 'φ' : `φ^${n}`
    }
  }
  return String(Math.round(v * 1000) / 1000)
}

export function Inspector({ result, onApply }: Props) {
  const [tab, setTab] = useState<'report' | 'dsl'>('report')
  const [draft, setDraft] = useState(() => JSON.stringify(result.design, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(JSON.stringify(result.design, null, 2))
    setJsonError(null)
  }, [result.design])

  const apply = () => {
    try {
      onApply(JSON.parse(draft) as LogoDesign)
      setJsonError(null)
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err))
    }
  }

  const snapNotes = result.notes.filter((n) => n.reason === 'snap')
  const solveNotes = result.notes.filter((n) => n.reason === 'constraint')
  // 計測は「寄せた結果」ではなく「測った事実」。→ で見せると直したように読める
  const measured = result.notes.filter((n) => n.reason === 'measure')

  return (
    <aside className="inspector">
      <div className="tabs">
        <button
          type="button"
          className={tab === 'report' ? 'tab tab--on' : 'tab'}
          onClick={() => setTab('report')}
        >
          正規化レポート
        </button>
        <button
          type="button"
          className={tab === 'dsl' ? 'tab tab--on' : 'tab'}
          onClick={() => setTab('dsl')}
        >
          DSL
        </button>
      </div>

      {tab === 'report' ? (
        <div className="inspector__body">
          <h3>{result.design.name}</h3>
          <p className="concept">{result.design.concept}</p>

          <dl className="stats">
            <div>
              <dt>シェイプ</dt>
              <dd>{result.design.shapes.length}</dd>
            </div>
            <div>
              <dt>制約</dt>
              <dd>{result.design.constraints.length}</dd>
            </div>
            <div>
              <dt>パーツ</dt>
              <dd>{result.design.parts.length}</dd>
            </div>
            <div>
              <dt>グリッド</dt>
              <dd>{result.design.grid}</dd>
            </div>
          </dl>

          {result.warnings.length > 0 && (
            <div className="alert alert--warn">
              <strong>警告</strong>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {result.constraintErrors.length > 0 && (
            <div className="alert alert--warn">
              <strong>未解決の制約</strong>
              <ul>
                {result.constraintErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <h4>
            計測 <span className="count">{measured.length}</span>
          </h4>
          {measured.length === 0 ? (
            <p className="muted">測れる輪郭がありませんでした。</p>
          ) : (
            <table className="notes">
              <tbody>
                {measured.map((n, i) => (
                  <tr key={i}>
                    <td className="notes__id">{n.shapeId}</td>
                    <td className="notes__field">{n.field}</td>
                    <td className="notes__to" colSpan={3}>
                      {n.field.includes('ずれ') && !n.field.includes('重心')
                        ? `${(n.from * 100).toFixed(1)}%`
                        : fmt(n.from)}
                      {n.label && <span className="notes__label">{n.label}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>
            寸法のスナップ <span className="count">{snapNotes.length}</span>
          </h4>
          {snapNotes.length === 0 ? (
            <p className="muted">丸めは発生しませんでした。</p>
          ) : (
            <table className="notes">
              <tbody>
                {snapNotes.map((n, i) => (
                  <tr key={i}>
                    <td className="notes__id">{n.shapeId}</td>
                    <td className="notes__field">{n.field}</td>
                    <td className="notes__from">{fmt(n.from)}</td>
                    <td className="notes__arrow">→</td>
                    <td className="notes__to">
                      {fmt(n.to)}
                      {n.label && <span className="notes__label">{n.label}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>
            制約による移動 <span className="count">{solveNotes.length}</span>
          </h4>
          {solveNotes.length === 0 ? (
            <p className="muted">中心の移動はありませんでした。</p>
          ) : (
            <table className="notes">
              <tbody>
                {solveNotes.map((n, i) => (
                  <tr key={i}>
                    <td className="notes__id">{n.shapeId}</td>
                    <td className="notes__field">{n.field}</td>
                    <td className="notes__from">{fmt(n.from)}</td>
                    <td className="notes__arrow">→</td>
                    <td className="notes__to">{fmt(n.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="inspector__body inspector__body--dsl">
          <textarea
            className="dsl"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {jsonError && <p className="alert alert--warn">{jsonError}</p>}
          <button type="button" className="btn" onClick={apply}>
            再ビルド
          </button>
        </div>
      )}
    </aside>
  )
}
