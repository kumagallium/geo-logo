import { describe, expect, it } from 'vitest'
import { packCircles } from './pack'
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
