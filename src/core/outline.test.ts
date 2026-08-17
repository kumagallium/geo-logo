import { describe, expect, it } from 'vitest'
import { build } from './build'
import { designSchema } from './dsl'
import { buildFromOutline, outlineStages, type OutlinePlan } from './outline'
import { offsetContour, sampleContours, smoothJoints, traceArcs, type ContourSegment, type Vec } from './trace'

/** 円弧の輪郭を SVG のパスデータにする（build.ts と同じ組み立て） */
function pathDataOf(segments: ContourSegment[]): string {
  const cmd = (s: ContourSegment) =>
    s.r === undefined
      ? `L ${s.x} ${s.y}`
      : `A ${s.r} ${s.r} 0 0 ${s.sweep ? 1 : 0} ${s.x} ${s.y}`
  const [first, ...rest] = segments
  return `M ${first.x} ${first.y} ${rest.map(cmd).join(' ')} ${cmd(first)} Z`
}

const sampleOf = (segments: ContourSegment[]) => sampleContours(pathDataOf(segments), 720)[0] ?? []

/** q から輪郭までの最短距離 */
function distanceTo(points: Vec[], q: Vec): number {
  let best = Number.POSITIVE_INFINITY
  for (const p of points) {
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d < best) best = d
  }
  return best
}

/** 楕円。角が無いので、等距離かどうかを素直に測れる */
const ellipse = (a: number, b: number, n = 200): Vec[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2
    return { x: Math.cos(t) * a, y: Math.sin(t) * b }
  })

const blob = (cx: number, cy: number, r: number, n = 12): Vec[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2
    return { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r }
  })

const plan = (contours: OutlinePlan['contours'], extra: Partial<OutlinePlan> = {}): OutlinePlan =>
  ({ name: '検査', concept: '検査用', contours, ...extra }) as OutlinePlan

const opsOf = (d: ReturnType<typeof buildFromOutline>) =>
  d.parts[0].steps.map((s) => `${s.op}:${s.ref}`)

describe('offsetContour', () => {
  it('外へ膨らんだ弧は、半径が幅のぶんだけ増える', () => {
    // 円は全部が外向き。ここが減るなら法線の向きか半径の符号が逆
    const fit = smoothJoints(traceArcs(ellipse(2, 2), { snapRadii: false }).segments)
    const grown = offsetContour(fit, 0.4)
    expect(grown).toHaveLength(fit.length)
    grown.forEach((s, i) => {
      expect((s.r as number) - (fit[i].r as number)).toBeCloseTo(0.4, 6)
    })
  })

  it('角の無い輪郭では、どこを測っても幅が同じ', () => {
    const fit = smoothJoints(traceArcs(ellipse(3, 2), { snapRadii: false }).segments)
    const width = 0.25
    const grown = offsetContour(fit, width)

    const base = sampleOf(fit)
    const gaps = sampleOf(grown).map((q) => distanceTo(base, q))
    expect(gaps.length).toBeGreaterThan(100)
    // 曲率が 1.5 倍ちがう長軸と短軸でも、離れ方は同じ
    expect(Math.min(...gaps)).toBeGreaterThan(width * 0.85)
    expect(Math.max(...gaps)).toBeLessThan(width * 1.15)
  })

  it('外へ広がる（内側へ縮まない）', () => {
    const fit = smoothJoints(traceArcs(ellipse(3, 2), { snapRadii: false }).segments)
    const area = (pts: Vec[]) => {
      let a = 0
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]
        const q = pts[(i + 1) % pts.length]
        a += p.x * q.y - q.x * p.y
      }
      return Math.abs(a) / 2
    }
    expect(area(sampleOf(offsetContour(fit, 0.3)))).toBeGreaterThan(area(sampleOf(fit)))
  })

  it('向きが逆に書かれた輪郭でも外へ広がる', () => {
    // 当てはめの結果は題材によって時計回りにも反時計回りにもなる
    const fit = smoothJoints(traceArcs(ellipse(3, 2).reverse(), { snapRadii: false }).segments)
    const far = sampleOf(offsetContour(fit, 0.3))
    const near = sampleOf(fit)
    const reach = (pts: Vec[]) => Math.max(...pts.map((p) => Math.hypot(p.x, p.y)))
    expect(reach(far)).toBeGreaterThan(reach(near))
  })
})

describe('キーライン', () => {
  // 洗練された紋章ロゴが例外なく持っている操作。重なった部品の境目が、どこも
  // 同じ太さの白で分かれている。輪郭方式では手で細長い hole を引いていた
  it('太らせた同じ形を、本体を置く直前に抜く', () => {
    const d = buildFromOutline(
      plan(
        [
          { label: '胴', role: 'solid', points: blob(0, 0, 2) },
          { label: '頭', role: 'solid', points: blob(1.6, 0, 1) },
        ] as never,
        { keyline: 0.12 },
      ),
    )
    expect(opsOf(d)).toEqual(['add:o0', 'sub:o1K', 'add:o1'])
  })

  it('1 枚目には付かない（抜きから始めると何も生まれない）', () => {
    const d = buildFromOutline(
      plan([{ label: '胴', role: 'solid', points: blob(0, 0, 2) }] as never, { keyline: 0.12 }),
    )
    expect(opsOf(d)).toEqual(['add:o0'])
  })

  it('抜き（hole）には付かない。もともと白なので要らない', () => {
    const d = buildFromOutline(
      plan(
        [
          { label: '胴', role: 'solid', points: blob(0, 0, 2) },
          { label: '目', role: 'hole', points: blob(0.6, -0.4, 0.3) },
        ] as never,
        { keyline: 0.12 },
      ),
    )
    expect(opsOf(d)).toEqual(['add:o0', 'sub:o1'])
    expect(d.shapes.some((s) => s.id.endsWith('K'))).toBe(false)
  })

  it('抜きは最後にまとめる。あとから来る部品に埋められては困る', () => {
    const d = buildFromOutline(
      plan(
        [
          { label: '目', role: 'hole', points: blob(0.6, -0.4, 0.3) },
          { label: '胴', role: 'solid', points: blob(0, 0, 2) },
          { label: '頭', role: 'solid', points: blob(1.6, 0, 1) },
        ] as never,
        { keyline: 0.12 },
      ),
    )
    expect(opsOf(d)).toEqual(['add:o1', 'sub:o2K', 'add:o2', 'sub:o0'])
  })

  it('幅は輪郭の大きさに依らず一定', () => {
    const width = 0.15
    const d = buildFromOutline(
      plan(
        [
          { label: '地', role: 'solid', points: blob(0, 0, 3) },
          { label: '大', role: 'solid', points: blob(-1.4, 0, 1.4) },
          { label: '小', role: 'solid', points: blob(1.8, 0, 0.5) },
        ] as never,
        { keyline: width },
      ),
    )
    const segmentsOf = (id: string) => {
      const s = d.shapes.find((x) => x.id === id)
      if (!s || s.kind !== 'contour') throw new Error(id)
      return s.segments
    }
    const gapOf = (id: string) => {
      const base = sampleOf(segmentsOf(id))
      const gaps = sampleOf(segmentsOf(`${id}K`)).map((q) => distanceTo(base, q))
      return gaps.reduce((a, b) => a + b, 0) / gaps.length
    }
    // 半径が 3 倍ちがう 2 つでも、白の幅は同じ
    expect(gapOf('o1')).toBeCloseTo(gapOf('o2'), 2)
  })

  it('重なった 2 枚が実際に白で分かれる', () => {
    const inkOf = (keyline: number) =>
      build(
        buildFromOutline(
          plan(
            [
              { label: '胴', role: 'solid', points: blob(0, 0, 2) },
              { label: '頭', role: 'solid', points: blob(2, 0, 1.2) },
            ] as never,
            { keyline },
          ),
        ),
      ).inkRatio
    // 境目に白が入るので、同じ 2 枚でも墨は減る
    expect(inkOf(0.12)).toBeLessThan(inkOf(0))
  })

  it('輪郭ごとに幅を変えられる（0 で切れる）', () => {
    const d = buildFromOutline(
      plan(
        [
          { label: '胴', role: 'solid', points: blob(0, 0, 2) },
          { label: '頭', role: 'solid', points: blob(1.6, 0, 1), keyline: 0 },
          { label: '耳', role: 'solid', points: blob(2.4, -0.8, 0.5) },
        ] as never,
        { keyline: 0.12 },
      ),
    )
    expect(opsOf(d)).toEqual(['add:o0', 'add:o1', 'sub:o2K', 'add:o2'])
  })

  it('書かなければ従来どおり（塗りを全部足してから抜く）', () => {
    const d = buildFromOutline(
      plan([
        { label: '胴', role: 'solid', points: blob(0, 0, 2) },
        { label: '目', role: 'hole', points: blob(0.6, -0.4, 0.3) },
        { label: '頭', role: 'solid', points: blob(1.6, 0, 1) },
      ] as never),
    )
    expect(opsOf(d)).toEqual(['add:o0', 'add:o2', 'sub:o1'])
    expect(d.shapes.some((s) => s.id.endsWith('K'))).toBe(false)
  })

  it('下描き用紙にも縁取りが出る', () => {
    const stages = outlineStages(
      plan(
        [
          { label: '胴', role: 'solid', points: blob(0, 0, 2) },
          { label: '目', role: 'hole', points: blob(0.6, -0.4, 0.3) },
        ] as never,
        { keyline: 0.12 },
      ),
    )
    expect(stages[0].keyline.length).toBeGreaterThan(0)
    expect(stages[1].keyline).toEqual([])
  })
})

describe('ほぼ直線の継ぎ目', () => {
  // 接線が平行に近いと biarc の半径が発散する。DSL の寸法上限（500）を超えると
  // designSchema が拒み、その弧 1 本ではなく**設計ごと**コンパイルに失敗する
  it('発散した半径は直線として出す', () => {
    // ごく浅い弧。当てはめ側は直線に落とすが、継ぎ目を揃える側が素通ししていた
    const shallow = Array.from({ length: 40 }, (_, i) => {
      const t = (i / 40) * Math.PI * 2
      return { x: Math.cos(t) * 3, y: Math.sin(t) * 3 * 0.02 }
    })
    for (const s of smoothJoints(traceArcs(shallow, { snapRadii: false }).segments)) {
      if (s.r !== undefined) expect(s.r).toBeLessThan(500)
    }
  })

  it('浅い輪郭でも設計として通る', () => {
    const flat = [
      { x: -3, y: -0.04 }, { x: -1, y: -0.06 }, { x: 1, y: -0.05 }, { x: 3, y: -0.03 },
      { x: 3, y: 0.9 }, { x: 1, y: 0.95 }, { x: -1, y: 0.94 }, { x: -3, y: 0.9 },
    ]
    const d = buildFromOutline(
      plan([{ label: '帯', role: 'solid', points: flat }] as never),
    )
    expect(() => designSchema.parse(d)).not.toThrow()
  })
})
