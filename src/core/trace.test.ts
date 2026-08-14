import { describe, expect, it } from 'vitest'
import { compile } from './index'
import {
  allocateArcs,
  contourComplexity,
  fitToModule,
  parseTransform,
  sampleContours,
  sampleContoursFromSvg,
  traceArcs,
  type Vec,
} from './trace'

/** 半径 r の円を n 点で表す */
function circlePoints(r: number, n = 360, cx = 0, cy = 0): Vec[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2
    return { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r }
  })
}

describe('traceArcs', () => {
  it('円は同じ半径の円弧だけで表される', () => {
    // 正解が分かる唯一の形。半径がばらつくなら当てはめが壊れている
    const { segments } = traceArcs(circlePoints(2), { maxArcs: 8, snapRadii: false })

    expect(segments.length).toBeGreaterThanOrEqual(3)
    for (const s of segments) {
      expect(s.r).toBeDefined()
      expect(s.r as number).toBeCloseTo(2, 1)
    }
  })

  it('指定した本数を超えない', () => {
    for (const budget of [4, 8, 16]) {
      const { segments } = traceArcs(circlePoints(2), { maxArcs: budget })
      expect(segments.length).toBeLessThanOrEqual(budget)
    }
  })

  it('本数を絞るほど許容誤差が大きくなる', () => {
    // 本数が抽象度のレバーになっている、という設計の確認
    const loose = traceArcs(circlePoints(2, 360), { maxArcs: 4 })
    const tight = traceArcs(circlePoints(2, 360), { maxArcs: 24 })
    expect(loose.tolerance).toBeGreaterThanOrEqual(tight.tolerance)
  })

  it('点が少なすぎるときは空を返す', () => {
    expect(traceArcs([{ x: 0, y: 0 }], { maxArcs: 8 }).segments).toEqual([])
  })
})

describe('sampleContours', () => {
  it('外形と抜きを面積の大きい順に返す', () => {
    // 大きい円のなかに小さい円（穴）
    const d = 'M -3 0 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0 Z M -1 0 a 1 1 0 1 0 2 0 a 1 1 0 1 0 -2 0 Z'
    const contours = sampleContours(d, 240)

    expect(contours.length).toBe(2)
    const extent = (pts: Vec[]) => Math.max(...pts.map((p) => Math.abs(p.x)))
    expect(extent(contours[0])).toBeGreaterThan(extent(contours[1]))
  })

  it('パスが無ければ空', () => {
    expect(sampleContours('', 120)).toEqual([])
  })
})

describe('fitToModule', () => {
  it('全輪郭に同じ変換をかける', () => {
    // 輪郭ごとに正規化すると、抜きが外形と揃わず別の場所へ飛ぶ
    const outer = circlePoints(100)
    const inner = circlePoints(20, 360, 50, 0)
    const [o, i] = fitToModule([outer, inner], 5)

    // 外形は span いっぱいに広がる
    expect(Math.max(...o.map((p) => p.x))).toBeCloseTo(2.5, 1)
    // 抜きは外形との位置関係を保ったまま縮む（中心が右へ寄っている）
    const icx = (Math.max(...i.map((p) => p.x)) + Math.min(...i.map((p) => p.x))) / 2
    expect(icx).toBeCloseTo(1.25, 1)
  })

  it('空なら空', () => {
    expect(fitToModule([], 5)).toEqual([])
  })
})

describe('contour シェイプ', () => {
  it('円弧の列から塗りが生まれ、作図円が設計図に載る', () => {
    const contours = fitToModule(sampleContours('M -3 0 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0 Z', 360))
    const { segments } = traceArcs(contours[0], { maxArcs: 8 })

    const result = compile({
      name: 'T',
      concept: 'c',
      module: 64,
      grid: 'golden',
      palette: {
        primary: '#111111',
        secondary: '#8A8A8A',
        accent: '#C2410C',
        background: '#FFFFFF',
      },
      shapes: [{ kind: 'contour', id: 'outline', segments }],
      constraints: [],
      groups: [],
      parts: [
        { id: 'mark', steps: [{ op: 'add', ref: 'outline' }], fill: 'primary', mirror: 'none' },
      ],
    })

    expect(result.built.parts[0].pathData).not.toBe('')
    // 円弧 1 本につき作図円が 1 つ出る
    const circles = result.built.construction.filter((c) => c.kind === 'circle')
    expect(circles.length).toBeGreaterThanOrEqual(segments.length)
  })
})

describe('parseTransform', () => {
  /**
   * 素材の SVG はトレース生成物が多く、scale(0.1,-0.1) のような上下反転を
   * 持つ。無視すると図形が逆さまになる（実測: PhyloPic のシルエットが全反転）。
   */
  it('translate と scale の合成を解釈する', () => {
    const m = parseTransform('translate(0.000000,1536.000000) scale(0.100000,-0.100000)')
    expect(m[0]).toBeCloseTo(0.1, 6)
    expect(m[3]).toBeCloseTo(-0.1, 6)
    expect(m[5]).toBeCloseTo(1536, 6)
  })

  it('rotate と matrix も解釈する', () => {
    const r = parseTransform('rotate(90)')
    expect(r[0]).toBeCloseTo(0, 6)
    expect(r[1]).toBeCloseTo(1, 6)
    expect(parseTransform('matrix(2,0,0,3,4,5)')).toEqual([2, 0, 0, 3, 4, 5])
  })

  it('知らない指定は無視して単位行列に倒す', () => {
    expect(parseTransform('skewX(20)')).toEqual([1, 0, 0, 1, 0, 0])
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0])
  })
})

describe('sampleContoursFromSvg', () => {
  it('transform を適用して座標を直す', () => {
    const svg =
      '<svg><g transform="translate(0,10) scale(1,-1)"><path d="M 0 0 L 4 0 L 4 4 Z"/></g></svg>'
    const pts = sampleContoursFromSvg(svg, 60)[0]
    // y 反転 + 移動なので、元の y=0..4 が y=10..6 になる
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(10, 1)
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(6, 1)
  })

  it('transform が複数種あるときは適用しない', () => {
    // 入れ子の異なる変換は扱わない。bbox 正規化に委ねる
    const svg =
      '<svg><g transform="scale(2)"><path d="M 0 0 L 4 0 L 4 4 Z"/></g>' +
      '<g transform="scale(3)"><path d="M 8 0 L 9 0 L 9 1 Z"/></g></svg>'
    expect(sampleContoursFromSvg(svg, 60).length).toBeGreaterThan(0)
  })
})

describe('contourComplexity', () => {
  /**
   * 「円弧を何本必要とするか」は大きさではなく曲がりの総量で決まる。
   * 大きさで配ると、小さくても複雑な抜き（腕と脚の間など）が潰れる。
   */
  it('円は大きさによらず 2π になる', () => {
    expect(contourComplexity(circlePoints(1))).toBeCloseTo(Math.PI * 2, 1)
    expect(contourComplexity(circlePoints(50))).toBeCloseTo(Math.PI * 2, 1)
  })

  it('こぶのある形は円より大きくなる', () => {
    const wavy = Array.from({ length: 360 }, (_, i) => {
      const t = (i / 360) * Math.PI * 2
      const r = 2 + 0.6 * Math.sin(t * 6)
      return { x: Math.cos(t) * r, y: Math.sin(t) * r }
    })
    expect(contourComplexity(wavy)).toBeGreaterThan(contourComplexity(circlePoints(2)) * 1.5)
  })

  it('点が足りなければ 0', () => {
    expect(contourComplexity([{ x: 0, y: 0 }])).toBe(0)
  })
})

describe('allocateArcs', () => {
  it('複雑な輪郭へ多く配る', () => {
    const simple = circlePoints(3)
    const complex = Array.from({ length: 360 }, (_, i) => {
      const t = (i / 360) * Math.PI * 2
      const r = 1 + 0.5 * Math.sin(t * 8)
      return { x: Math.cos(t) * r, y: Math.sin(t) * r }
    })
    // 小さいほうが複雑。大きさで配っていたら逆になる
    const [a, b] = allocateArcs([simple, complex], 40)
    expect(b).toBeGreaterThan(a)
  })

  it('どの輪郭にも最低本数を確保する', () => {
    const quota = allocateArcs([circlePoints(3), circlePoints(0.2)], 8, 3)
    for (const q of quota) expect(q).toBeGreaterThanOrEqual(3)
  })

  it('輪郭が無ければ空', () => {
    expect(allocateArcs([], 20)).toEqual([])
  })
})
