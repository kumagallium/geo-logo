import { describe, expect, it } from 'vitest'
import { packCircles, skeleton, tangentHull } from './pack'
import type { Vec } from './trace'

const circle = (cx: number, cy: number, r: number, n = 180): Vec[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2
    return { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r }
  })

describe('packCircles', () => {
  /**
   * 輪郭をなぞらずに「円が自然に収まる位置」だけを取り出す。ずっと空席だった
   * 配置の判断を、形を写さずに埋めるための道具。
   */
  it('円ひとつからは、ほぼ同じ円が 1 個出る', () => {
    const [first] = packCircles([{ points: circle(0, 0, 3), solid: true }], { count: 3 })
    expect(first.r).toBeGreaterThan(2.7)
    expect(first.r).toBeLessThan(3.1)
    expect(Math.hypot(first.x, first.y)).toBeLessThan(0.3)
  })

  it('大きい順に出る', () => {
    const shape = [
      { points: circle(-3, 0, 2.5), solid: true },
      { points: circle(3, 0, 1.2), solid: true },
    ]
    const out = packCircles(shape, { count: 4 })
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < out.length; i++) expect(out[i].r).toBeLessThanOrEqual(out[i - 1].r)
    // 最初の円は大きいほうの塊に入る
    expect(out[0].x).toBeLessThan(0)
  })

  it('同じ場所を何度も返さない', () => {
    const out = packCircles([{ points: circle(0, 0, 3), solid: true }], { count: 5 })
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThan(0.5)
      }
    }
  })

  it('小さすぎる円は採らない', () => {
    // 要約が目的なので、粒のような円まで拾うと抽象度が壊れる
    const out = packCircles([{ points: circle(0, 0, 3), solid: true }], {
      count: 20,
      minRatio: 0.4,
    })
    for (const c of out) expect(c.r).toBeGreaterThanOrEqual(out[0].r * 0.4)
  })

  it('抜きは避けて置かれる', () => {
    const out = packCircles(
      [
        { points: circle(0, 0, 3), solid: true },
        { points: circle(0, 0, 2), solid: false },
      ],
      { count: 3 },
    )
    // 中心は抜かれているので、円は環の中に入る
    for (const c of out) expect(Math.hypot(c.x, c.y)).toBeGreaterThan(1.5)
  })

  it('空なら空', () => {
    expect(packCircles([], { count: 4 })).toEqual([])
  })
})

describe('tangentHull', () => {
  /**
   * 円板を union すると、大きさの違う 2 円は 2 つのコブになる。外接接線で
   * 結ぶと円錐台になり、付け根から末端へ細くなる形が生まれる。
   * 太さが一定の管はどうしても風船に見える。
   */
  it('大きさの違う 2 円を胴で結ぶ', () => {
    const d = tangentHull({ x: 0, y: 0, r: 2 }, { x: 5, y: 0, r: 1 })
    expect(d).not.toBeNull()
    // 四辺形なので座標が 4 組
    expect((d as string).match(/[ML]/g)).toHaveLength(4)
  })

  it('片方がもう片方を含むなら胴は要らない', () => {
    expect(tangentHull({ x: 0, y: 0, r: 3 }, { x: 0.5, y: 0, r: 1 })).toBeNull()
  })

  it('接点は円周上にある', () => {
    const a = { x: 0, y: 0, r: 2 }
    const b = { x: 6, y: 0, r: 1 }
    const nums = (tangentHull(a, b) as string).match(/-?\d+\.?\d*/g)?.map(Number) ?? []
    const pts = [0, 2, 4, 6].map((i) => ({ x: nums[i], y: nums[i + 1] }))
    // 最初と最後が a の周上、中の 2 つが b の周上
    expect(Math.hypot(pts[0].x - a.x, pts[0].y - a.y)).toBeCloseTo(a.r, 2)
    expect(Math.hypot(pts[1].x - b.x, pts[1].y - b.y)).toBeCloseTo(b.r, 2)
  })
})

describe('skeleton', () => {
  it('最大の円を根として木を作る', () => {
    const circles = [
      { x: 0, y: 0, r: 3 },
      { x: 4, y: 0, r: 1 },
      { x: 6, y: 0, r: 0.5 },
    ]
    const edges = skeleton(circles)
    // 円の数 - 1 本
    expect(edges).toHaveLength(2)
    // いちばん小さい円は、自分より大きく最も近い円に付く
    expect(edges.some(([i, j]) => i === 2 && j === 1)).toBe(true)
  })

  it('円が 1 つなら辺は無い', () => {
    expect(skeleton([{ x: 0, y: 0, r: 1 }])).toEqual([])
  })
})
