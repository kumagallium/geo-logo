import { useMemo } from 'react'
import { compile, type LogoDesign } from '../../core/index'

type Props = {
  designs: LogoDesign[]
  selected: LogoDesign | null
  onSelect: (design: LogoDesign) => void
}

/**
 * 生成された候補を並べて選ばせる。
 *
 * 幾何の破綻は design-agent が自動で弾くが、構図が「格好良いか」は
 * 機械判定できない。複数出して人が選ぶのが、この道具の正しい形。
 */
export function Candidates({ designs, selected, onSelect }: Props) {
  const previews = useMemo(
    () =>
      designs.map((design) => {
        try {
          const built = compile(design)
          return { design, svg: built.logoSvg, ink: built.built.inkRatio, error: null as string | null }
        } catch (err) {
          return {
            design,
            svg: '',
            ink: 0,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    [designs],
  )

  if (previews.length === 0) return null

  return (
    <section className="candidates">
      <h2>候補（{previews.length}）— クリックで選択</h2>
      <div className="candidates__strip">
        {previews.map((p, i) => (
          <button
            type="button"
            key={i}
            className={selected === p.design ? 'candidate candidate--on' : 'candidate'}
            onClick={() => onSelect(p.design)}
            title={p.design.concept}
          >
            {p.error ? (
              <span className="candidate__error">エラー</span>
            ) : (
              // svg は自前の render.ts が生成したもの（外部入力を素通ししない）
              <span className="candidate__art" dangerouslySetInnerHTML={{ __html: p.svg }} />
            )}
            <span className="candidate__meta">
              <strong>{p.design.name}</strong>
              <small>インク {(p.ink * 100).toFixed(0)}%</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
