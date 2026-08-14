import { describe, expect, it } from 'vitest'
import { compile } from './index'
import { fitToModule, sampleContours, traceArcs, type Vec } from './trace'

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
