import { describe, expect, it } from 'vitest'
import { build } from './build'
import { designSchema, type LogoDesign } from './dsl'
import { distinctCount, islandsOf, measure } from './metrics'

const design = (shapes: LogoDesign['shapes'], steps: Array<{ op: 'add' | 'sub'; ref: string }>) =>
  designSchema.parse({
    name: '検査',
    concept: '検査',
    shapes,
    parts: [{ id: 'mark', steps }],
  })

const built = (d: LogoDesign) => build(d)

describe('島と覗き', () => {
  it('重なった 2 円は 1 つの島', () => {
    const d = design(
      [
        { kind: 'circle', id: 'a', cx: -0.8, cy: 0, r: 1 },
        { kind: 'circle', id: 'b', cx: 0.8, cy: 0, r: 1 },
      ],
      [
        { op: 'add', ref: 'a' },
        { op: 'add', ref: 'b' },
      ],
    )
    expect(islandsOf(built(d)).islands).toHaveLength(1)
  })

  it('離れた 2 円は 2 つの島', () => {
    const d = design(
      [
        { kind: 'circle', id: 'a', cx: -2, cy: 0, r: 1 },
        { kind: 'circle', id: 'b', cx: 2, cy: 0, r: 1 },
      ],
      [
        { op: 'add', ref: 'a' },
        { op: 'add', ref: 'b' },
      ],
    )
    const { islands } = islandsOf(built(d))
    expect(islands).toHaveLength(2)
    expect(islands[0]).toBeCloseTo(0.5, 1)
  })

  /**
   * 外接する円どうしは、接点を通る行で画素が横に隣り合うので繋がる。
   * わずかでも離れれば分かれる。この境目を明示しておく。
   */
  it('外接する 2 円は繋がって見える', () => {
    const d = design(
      [
        { kind: 'circle', id: 'a', cx: -1, cy: 0, r: 1 },
        { kind: 'circle', id: 'b', cx: 1, cy: 0, r: 1 },
      ],
      [
        { op: 'add', ref: 'a' },
        { op: 'add', ref: 'b' },
      ],
    )
    expect(islandsOf(built(d)).islands).toHaveLength(1)
  })

  it('わずかに離れた 2 円は分かれる', () => {
    const d = design(
      [
        { kind: 'circle', id: 'a', cx: -1.06, cy: 0, r: 1 },
        { kind: 'circle', id: 'b', cx: 1.06, cy: 0, r: 1 },
      ],
      [
        { op: 'add', ref: 'a' },
        { op: 'add', ref: 'b' },
      ],
    )
    expect(islandsOf(built(d)).islands).toHaveLength(2)
  })

  it('白に囲まれた墨は島ではなく覗き', () => {
    const d = design(
      [
        { kind: 'circle', id: 'outer', cx: 0, cy: 0, r: 2 },
        { kind: 'circle', id: 'white', cx: 0, cy: 0, r: 1.2 },
        { kind: 'circle', id: 'pupil', cx: 0, cy: 0, r: 0.5 },
      ],
      [
        { op: 'add', ref: 'outer' },
        { op: 'sub', ref: 'white' },
        { op: 'add', ref: 'pupil' },
      ],
    )
    const { islands, nests } = islandsOf(built(d))
    expect(islands).toHaveLength(1)
    expect(nests).toBe(1)
  })

  it('ただの穴は覗きに数えない', () => {
    const d = design(
      [
        { kind: 'circle', id: 'outer', cx: 0, cy: 0, r: 2 },
        { kind: 'circle', id: 'hole', cx: 0, cy: 0, r: 1 },
      ],
      [
        { op: 'add', ref: 'outer' },
        { op: 'sub', ref: 'hole' },
      ],
    )
    expect(islandsOf(built(d)).nests).toBe(0)
  })
})

describe('角', () => {
  it('丸には角が出ない', () => {
    const d = design([{ kind: 'circle', id: 'a', cx: 0, cy: 0, r: 2 }], [{ op: 'add', ref: 'a' }])
    expect(measure(d, built(d)).corners).toBe(0)
  })

  it('四角には角が出る', () => {
    const d = design(
      [{ kind: 'rect', id: 'a', cx: 0, cy: 0, w: 3, h: 3 }],
      [{ op: 'add', ref: 'a' }],
    )
    expect(measure(d, built(d)).corners).toBe(4)
  })
})

describe('種類数', () => {
  it('相対 8% 以内は同じ種類として畳む', () => {
    expect(distinctCount([1, 1.05, 1.5, 3])).toBe(3)
    expect(distinctCount([1, 1.2, 1.5, 3])).toBe(4)
  })

  it('0 と負は数えない', () => {
    expect(distinctCount([0, -1, 2])).toBe(1)
  })
})
