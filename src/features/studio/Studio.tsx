import { useMemo, useState } from 'react'
import { compile, designFromReference, type ReferenceOptions } from '../../core/index'

/**
 * 作図しながら詰めるための画面。
 *
 * 一発で作って終わりにしない。判断（どこが違うか・どちらが良いか）は人が持ち、
 * 正確さ（対称・体系・接線・作図）は道具が持つ、という分担にする。
 *
 * 抽象度のつまみを表に出したのは、ロゴとして必要な抽象度が題材で違うため。
 * 家紋のような紋章は数個の円で足り、動物の立ち姿は姿勢が出るまで要る。
 * これまでは環境変数に埋もれていて調整できなかった。
 */

type Params = Required<Pick<ReferenceOptions, 'circles' | 'channel'>> & {
  taper: boolean
  ground: boolean
  smooth: boolean
}

const DEFAULTS: Params = { circles: 9, channel: 0, taper: true, ground: true, smooth: true }

export default function Studio() {
  const [svgText, setSvgText] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [params, setParams] = useState<Params>(DEFAULTS)
  const [error, setError] = useState<string | null>(null)

  const output = useMemo(() => {
    if (!svgText) return null
    try {
      const built = designFromReference(svgText, {
        circles: params.circles,
        channel: params.channel,
        taper: params.taper,
        ground: params.ground,
        smooth: params.smooth,
        name: fileName.replace(/\.svg$/i, '') || 'mark',
      })
      if (!built) return null
      return { ...built, compiled: compile(built.design) }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [svgText, params, fileName])

  const load = async (file: File) => {
    setError(null)
    const text = await file.text()
    if (!/<svg[\s>]/i.test(text)) {
      setError('SVG ファイルを読み込んでください')
      return
    }
    setFileName(file.name)
    setSvgText(text)
  }

  /** 同梱の参照。出発点が無いと何も試せないので用意しておく */
  const samples: Array<[string, string]> = [
    ['gorilla.svg', 'ゴリラ（CC0・PhyloPic）'],
    ['tomoe.svg', '二つ巴（パブリックドメイン）'],
    ['janome.svg', '三つ盛蛇の目（パブリックドメイン）'],
  ]

  const loadSample = async (file: string) => {
    setError(null)
    const res = await fetch(`${import.meta.env.BASE_URL}refs/${file}`)
    if (!res.ok) {
      setError('サンプルを読み込めませんでした')
      return
    }
    setFileName(file)
    setSvgText(await res.text())
  }

  const set = <K extends keyof Params>(key: K, value: Params[K]) =>
    setParams((prev) => ({ ...prev, [key]: value }))

  return (
    <section className="studio">
      <header className="studio__head">
        <h2>作図スタジオ</h2>
        <p className="studio__note">
          参照する形から「円が収まる位置」だけを取り出し、そこから作図し直します。
          輪郭はなぞりません。
        </p>
      </header>

      <div
        className="studio__drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) void load(file)
        }}
      >
        <label>
          参照する SVG をドロップ、または
          <input
            type="file"
            accept=".svg,image/svg+xml"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void load(file)
            }}
          />
        </label>
        {fileName && <span className="studio__file">{fileName}</span>}
      </div>

      <div className="studio__samples">
        <span>サンプル:</span>
        {samples.map(([file, label]) => (
          <button key={file} type="button" className="btn btn--ghost" onClick={() => void loadSample(file)}>
            {label}
          </button>
        ))}
      </div>

      {error && <p className="studio__error">{error}</p>}

      {svgText && (
        <>
          <div className="studio__controls">
            <label>
              <span>
                抽象度 — 円 {params.circles} 個
                <em>{params.circles <= 6 ? '紋章寄り' : params.circles >= 13 ? '具象寄り' : '中間'}</em>
              </span>
              <input
                type="range"
                min={3}
                max={20}
                value={params.circles}
                onChange={(e) => set('circles', Number(e.target.value))}
              />
            </label>

            <label>
              <span>
                白の隙間 {(params.channel * 100).toFixed(0)}%
                <em>付け根の推定が外れると胴を削ります</em>
              </span>
              <input
                type="range"
                min={0}
                max={20}
                value={Math.round(params.channel * 100)}
                onChange={(e) => set('channel', Number(e.target.value) / 100)}
              />
            </label>

            <div className="studio__toggles">
              {(
                [
                  ['taper', 'テーパー（骨格を外接接線で包む）'],
                  ['ground', '接地（下端を水平に切る）'],
                  ['smooth', '継ぎ目の接線を揃える'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="studio__toggle">
                  <input
                    type="checkbox"
                    checked={params[key]}
                    onChange={(e) => set(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              <button type="button" onClick={() => setParams(DEFAULTS)}>
                既定に戻す
              </button>
            </div>
          </div>

          {output ? (
            <>
              <dl className="studio__stats">
                <div>
                  <dt>きっかけの円</dt>
                  <dd>{output.circles.length}</dd>
                </div>
                <div>
                  <dt>輪郭の円弧</dt>
                  <dd>{output.arcs}</dd>
                </div>
                <div>
                  <dt>異なる半径</dt>
                  <dd>{output.radii} 種</dd>
                </div>
                <div>
                  <dt>対称</dt>
                  <dd>{output.symmetric ? 'あり' : 'なし'}</dd>
                </div>
              </dl>

              <div className="studio__panes">
                <figure>
                  {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 自前で組み立てた SVG */}
                  <div dangerouslySetInnerHTML={{ __html: output.compiled.logoSvg }} />
                  <figcaption>完成マーク</figcaption>
                </figure>
                <figure>
                  {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 自前で組み立てた SVG */}
                  <div dangerouslySetInnerHTML={{ __html: output.compiled.blueprintSvg }} />
                  <figcaption>設計図</figcaption>
                </figure>
              </div>
            </>
          ) : (
            <p className="studio__error">
              この素材からは形を取り出せませんでした。線だけで描かれた SVG は対象外です。
            </p>
          )}
        </>
      )}
    </section>
  )
}
