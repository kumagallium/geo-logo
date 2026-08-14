import { describe, expect, it } from 'vitest'
import { compile } from './index'
import { checkConstraints, normalize } from './normalize'
import { samples } from './samples'
import { hasCenter, radiusOf, type Centered, type LogoDesign } from './dsl'
import { PHI, radiusCandidates, snap } from './units'

/** 中心を持つシェイプを id で取り出す（union の絞り込みをテスト側でまとめる） */
function centeredById(design: LogoDesign, id: string): Centered {
  const found = design.shapes.find((s) => s.id === id)
  if (!found || !hasCenter(found)) throw new Error(`中心を持つシェイプ "${id}" がない`)
  return found
}

const base: LogoDesign = {
  name: 'test',
  concept: 'test',
  module: 64,
  grid: 'golden',
  palette: { primary: '#000', secondary: '#888', accent: '#f00', background: '#fff' },
  shapes: [],
  constraints: [],
  groups: [],
  parts: [],
}

describe('units.snap', () => {
  it('φ に十分近い値は φ に丸める', () => {
    const r = snap(1.6, radiusCandidates(), 0.09)
    expect(r.value).toBeCloseTo(PHI, 6)
    expect(r.changed).toBe(true)
  })

  it('どの候補からも遠い値は意図値として温存する', () => {
    const r = snap(0.031, radiusCandidates(), 0.001)
    expect(r.value).toBe(0.031)
    expect(r.changed).toBe(false)
  })
})

describe('normalize', () => {
  it('外接制約を満たすまで中心を動かす', () => {
    const design: LogoDesign = {
      ...base,
      shapes: [
        { kind: 'circle', id: 'a', cx: 0, cy: 0, r: 2, pinned: true },
        { kind: 'circle', id: 'b', cx: 2.4, cy: 0, r: 1 },
      ],
      constraints: [{ type: 'tangent', a: 'a', b: 'b', mode: 'external' }],
      parts: [{ id: 'p', fill: 'primary', mirror: 'none', steps: [{ op: 'add', ref: 'a' }] }],
    }

    // 補正前は 2.4、外接なら 3.0 のはず
    expect(checkConstraints(design).length).toBeGreaterThan(0)

    const { design: fixed } = normalize(design)
    expect(checkConstraints(fixed)).toEqual([])
    const b = centeredById(fixed, 'b')
    expect(Math.hypot(b.cx, b.cy)).toBeCloseTo(3, 3)
  })

  it('pinned なシェイプは動かさない', () => {
    const design: LogoDesign = {
      ...base,
      shapes: [
        { kind: 'circle', id: 'a', cx: 0, cy: 0, r: 2, pinned: true },
        { kind: 'circle', id: 'b', cx: 2.4, cy: 0, r: 1, pinned: true },
      ],
      constraints: [{ type: 'tangent', a: 'a', b: 'b', mode: 'external' }],
      parts: [{ id: 'p', fill: 'primary', mirror: 'none', steps: [{ op: 'add', ref: 'a' }] }],
    }
    const { design: fixed } = normalize(design)
    expect(centeredById(fixed, 'a').cx).toBe(0)
    expect(centeredById(fixed, 'b').cx).toBe(2.4)
  })

  it('半径を先に丸めてから制約を解くので、接点にズレが残らない', () => {
    const design: LogoDesign = {
      ...base,
      shapes: [
        { kind: 'circle', id: 'a', cx: 0, cy: 0, r: 1.61, pinned: true },
        { kind: 'circle', id: 'b', cx: 3.1, cy: 0.2, r: 2.6 },
      ],
      constraints: [{ type: 'tangent', a: 'a', b: 'b', mode: 'external' }],
      parts: [{ id: 'p', fill: 'primary', mirror: 'none', steps: [{ op: 'add', ref: 'a' }] }],
    }
    const { design: fixed } = normalize(design)
    expect(radiusOf(centeredById(fixed, 'a'))).toBeCloseTo(PHI, 6)
    expect(radiusOf(centeredById(fixed, 'b'))).toBeCloseTo(PHI * PHI, 6)
    expect(checkConstraints(fixed)).toEqual([])
  })

  it('align は指定軸の座標を揃える', () => {
    const design: LogoDesign = {
      ...base,
      shapes: [
        { kind: 'circle', id: 'a', cx: 0.1, cy: -2, r: 1 },
        { kind: 'circle', id: 'b', cx: -0.2, cy: 0, r: 1 },
        { kind: 'circle', id: 'c', cx: 0.3, cy: 2, r: 1 },
      ],
      constraints: [{ type: 'align', ids: ['a', 'b', 'c'], axis: 'x' }],
      parts: [{ id: 'p', fill: 'primary', mirror: 'none', steps: [{ op: 'add', ref: 'a' }] }],
    }
    const { design: fixed } = normalize(design)
    expect(checkConstraints(fixed)).toEqual([])
  })

  it('存在しない参照を warnings に落とす', () => {
    const design: LogoDesign = {
      ...base,
      shapes: [{ kind: 'circle', id: 'a', cx: 0, cy: 0, r: 1 }],
      parts: [{ id: 'p', fill: 'primary', mirror: 'none', steps: [{ op: 'add', ref: 'nope' }] }],
    }
    const { unresolved } = normalize(design)
    expect(unresolved.some((u) => u.includes('nope'))).toBe(true)
  })
})

describe('compile', () => {
  it.each(samples.map((s) => [s.name, s] as const))('サンプル %s がビルドできる', (_name, sample) => {
    const result = compile(sample)
    expect(result.warnings).toEqual([])
    expect(result.constraintErrors).toEqual([])
    expect(result.built.parts.length).toBeGreaterThan(0)
    for (const part of result.built.parts) {
      expect(part.pathData.length).toBeGreaterThan(0)
    }
    expect(result.logoSvg).toContain('<svg')
    expect(result.blueprintSvg).toContain('<svg')
  })

  it('完成ロゴと設計図は同一のパスデータを共有する', () => {
    const result = compile(samples[0])
    const d = result.built.parts[0].pathData
    expect(result.logoSvg).toContain(d)
    expect(result.blueprintSvg).toContain(d)
  })

  it('intersect が実際に面積を削っている（ヴェシカが元円より小さい）', () => {
    const result = compile(samples[0])
    const { artBounds } = result.built
    const circleDiameter = 2 * PHI * samples[0].module
    expect(artBounds.height).toBeLessThan(circleDiameter)
    expect(artBounds.width).toBeGreaterThan(artBounds.height)
  })

  it('外形を add してから intersect すると全体が外形に戻る（実測した失敗の再現）', () => {
    // gpt-oss-120b が実際に出した構成: 基準円を add し、要素を足し、
    // 最後に同じ基準円で intersect する。幾何としては正常（面積も縦横比も妥当）で
    // 他の判定を素通りするが、出力はただの黒い円になる。
    const design: LogoDesign = {
      ...base,
      shapes: [
        { kind: 'circle', id: 'base', cx: 0, cy: 0, r: 3, pinned: true },
        { kind: 'bar', id: 'peak', x1: -2, y1: 1, x2: 0, y2: -2, w: 0.5, cap: 'butt' },
      ],
      parts: [
        {
          id: 'logo',
          fill: 'primary',
          mirror: 'none',
          steps: [
            { op: 'add', ref: 'base' },
            { op: 'add', ref: 'peak' },
            { op: 'intersect', ref: 'base' },
          ],
        },
      ],
    }
    const result = compile(design)
    expect(result.warnings).toEqual([])
    expect(result.built.collapsedTo).toBe('base')
  })

  it('正しく構成された設計は潰れ判定に引っかからない', () => {
    for (const sample of samples) {
      expect(compile(sample).built.collapsedTo).toBeNull()
    }
    // 外形クリップを正しく使った形（外形を add せず、要素だけ add してから intersect）
    const clipped: LogoDesign = {
      ...base,
      shapes: [
        { kind: 'circle', id: 'frame', cx: 0, cy: 0, r: 3, pinned: true },
        { kind: 'bar', id: 'peak', x1: -3, y1: 2, x2: 0, y2: -3, w: 0.8, cap: 'butt' },
      ],
      parts: [
        {
          id: 'logo',
          fill: 'primary',
          mirror: 'vertical',
          steps: [
            { op: 'add', ref: 'peak' },
            { op: 'intersect', ref: 'frame' },
          ],
        },
      ],
    }
    expect(compile(clipped).built.collapsedTo).toBeNull()
  })

  it('mirror:vertical は左右対称な形を作る', () => {
    const design: LogoDesign = {
      ...base,
      shapes: [{ kind: 'circle', id: 'a', cx: 2, cy: 0, r: 1, pinned: true }],
      parts: [{ id: 'p', fill: 'primary', mirror: 'vertical', steps: [{ op: 'add', ref: 'a' }] }],
    }
    const result = compile(design)
    const { artBounds } = result.built
    expect(artBounds.x + artBounds.width / 2).toBeCloseTo(0, 3)
    expect(artBounds.width).toBeCloseTo(6 * design.module, 1)
  })
})

describe('内在寸法', () => {
  /**
   * viewBox だけの SVG は `<img>` に置いたとき固有の縦横比を持たず、枠に
   * 合わせて引き伸ばされる。真円が楕円に見える原因になった。
   */
  it('完成ロゴと設計図は viewBox と一致する width / height を持つ', () => {
    const r = compile(samples[0])
    for (const svg of [r.logoSvg, r.blueprintSvg]) {
      const w = Number(svg.match(/\swidth="([\d.]+)"/)?.[1])
      const h = Number(svg.match(/\sheight="([\d.]+)"/)?.[1])
      const vb = svg.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number) ?? []
      expect(w).toBeCloseTo(vb[2], 3)
      expect(h).toBeCloseTo(vb[3], 3)
    }
  })
})
