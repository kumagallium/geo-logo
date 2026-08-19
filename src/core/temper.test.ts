import { describe, expect, it } from 'vitest'
import type { LogoDesign } from './dsl'
import { temper, type Recorder } from './temper'
import { PHI } from './units'

/**
 * 整定は「壊さずに数値だけをモジュール系へ載せる」パス。
 * 効いていることと、効きすぎていないことの両方を固定する。
 */

type Seg = { x: number; y: number; r?: number; sweep?: boolean }

function designWith(segments: Seg[][]): LogoDesign {
  return {
    name: 'test',
    concept: '',
    module: 64,
    grid: 'golden',
    palette: { ink: '#000', background: '#fff' },
    shapes: segments.map((segs, i) => ({
      kind: 'contour' as const,
      id: `r${i}`,
      segments: segs.map((s) => ({ sweep: true, ...s })),
    })),
    constraints: [],
    groups: [],
    parts: [{ id: 'p', steps: segments.map((_, i) => ({ op: 'add' as const, ref: `r${i}` })), fill: 'ink', mirror: 'none' as const }],
  } as unknown as LogoDesign
}

const collect = () => {
  const notes: Array<{ id: string; field: string; from: number; to: number; label: string | null }> = []
  const record: Recorder = (id, field, from, to, label) => notes.push({ id, field, from, to, label })
  return { notes, record }
}

/**
 * 円周上に n 点を置き、弧半径 r で結んだ輪郭。
 *
 * 弦は 2R·sin(π/n) なので、r ≧ R であれば必ず円弧が成立する。復元が返す
 * 輪郭も常にこの条件を満たしている（成立しない弧は書けない）ので、
 * 試験もその前提で作る。
 */
function ring(R: number, n: number, r: number, cx = 0, cy = 0, sy = 1): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    out.push({ x: cx + R * Math.cos(t), y: cy + R * sy * Math.sin(t), r })
  }
  return out
}

describe('整定', () => {
  it('ほぼ同じ半径どうしを 1 つに寄せ、種類を増やさない', () => {
    // 3 つの輪郭がわずかに違う半径を持つ。まとめて 1 つの値になってほしい。
    // 弧半径と点の乗る円を一致させる（＝継ぎ目が滑らか）。整定は滑らかさを
    // 損なう寄せを避けるので、そこを崩す差は寄せられない——それが正しい
    const design = designWith([
      // 楕円にする。真円だと「円へ整形」されて contour でなくなり、
      // ここで見たい半径の統合が観測できない
      ring(1.001, 8, 1.001, 0, 0, 0.7),
      ring(0.999, 8, 0.999, 0, 0, 0.7),
      ring(1.0, 8, 1.0, 0, 0, 0.7),
    ])
    const { record } = collect()
    temper(design, record)

    const radii = new Set<string>()
    for (const s of design.shapes) {
      if (s.kind !== 'contour') continue
      for (const g of s.segments) if (g.r !== undefined) radii.add(g.r.toFixed(4))
    }
    expect(radii.size).toBe(1)
    // 寄せ先はモジュール系の値（1）
    expect(Number([...radii][0])).toBeCloseTo(1, 6)
  })

  it('小さな半径を比率で守る（大きく動かさない）', () => {
    // 瞳のような小さい弧。絶対差で丸めると数十%動いてしまう
    const design = designWith([ring(0.06, 8, 0.071, 0, 0, 0.7)])
    const { record } = collect()
    temper(design, record)

    const r = (design.shapes[0] as { segments: Seg[] }).segments[0].r as number
    expect(Math.abs(r - 0.071) / 0.071).toBeLessThan(0.07)
  })

  it('縦横比が正準比の近くなら、そこへ寄せる', () => {
    // 1.60 は φ(1.618) の 1.1% 手前
    const design = designWith([ring(0.8, 12, 0.9, 0, 0, 1 / 1.6)])
    const { notes, record } = collect()
    temper(design, record)

    const xs = (design.shapes[0] as { segments: Seg[] }).segments.map((s) => s.x)
    const ys = (design.shapes[0] as { segments: Seg[] }).segments.map((s) => s.y)
    const ratio = (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))
    expect(ratio).toBeCloseTo(PHI, 4)
    expect(notes.some((n) => n.field === '縦横比' && n.label === '1:φ')).toBe(true)
  })

  it('正準比から遠ければ、比は動かさない', () => {
    const design = designWith([ring(0.8, 12, 0.9, 0, 0, 1 / 1.3)])
    const { notes, record } = collect()
    temper(design, record)
    expect(notes.some((n) => n.field === '縦横比')).toBe(false)
  })

  it('墨の重心を原点へ置く（穴は差し引く）', () => {
    // 右へ寄せた外形。重心が原点に来るよう平行移動されるはず
    const design = designWith([ring(1, 8, 1.1, 3, 0, 0.7)])
    const { record } = collect()
    temper(design, record)

    const segs = (design.shapes[0] as { segments: Seg[] }).segments
    const cx = segs.reduce((a, s) => a + s.x, 0) / segs.length
    expect(cx).toBeCloseTo(0, 6)
  })

  it('弧が成立しなくなる半径は与えない（半径 ≧ 弦の半分）', () => {
    const design = designWith([ring(0.8, 12, 0.9, 0, 0, 1 / 1.6), ring(0.2, 8, 0.21)])
    const { record } = collect()
    temper(design, record)

    for (const s of design.shapes) {
      if (s.kind !== 'contour') continue
      const segs = s.segments
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i]
        if (g.r === undefined) continue
        const from = segs[(i - 1 + segs.length) % segs.length]
        const chord = Math.hypot(g.x - from.x, g.y - from.y)
        expect(g.r).toBeGreaterThanOrEqual(chord / 2 - 1e-9)
      }
    }
  })

  it('滑らかさを損なう寄せはしない（継ぎ目の折れを悪化させない）', () => {
    // 当てはめの段で G1 連続に均された輪郭。半径を動かすと継ぎ目がずれるので、
    // 悪化するなら寄せないでほしい
    const R = 0.83
    const n = 10
    const segs: Seg[] = Array.from({ length: n }, (_, i) => {
      const t = ((i + 1) / n) * Math.PI * 2
      return { x: R * Math.cos(t), y: R * 0.7 * Math.sin(t), r: R, sweep: true }
    })
    const design = designWith([segs])

    const tangent = (from: Seg, seg: Seg) => {
      const dx = seg.x - from.x
      const dy = seg.y - from.y
      const d = Math.hypot(dx, dy)
      const r = Math.max(seg.r as number, d / 2)
      const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0))
      const sign = seg.sweep ? 1 : -1
      const cx = (from.x + seg.x) / 2 + sign * h * (-dy / d)
      const cy = (from.y + seg.y) / 2 + sign * h * (dx / d)
      const t = (px: number, py: number) => Math.atan2(sign * (px - cx), -sign * (py - cy))
      return [t(from.x, from.y), t(seg.x, seg.y)] as const
    }
    const brk = (list: Seg[]) => {
      let sum = 0
      for (let i = 0; i < list.length; i++) {
        const a = tangent(list[(i - 1 + list.length) % list.length], list[i])
        const b = tangent(list[i], list[(i + 1) % list.length])
        sum += Math.abs(Math.atan2(Math.sin(b[0] - a[1]), Math.cos(b[0] - a[1])))
      }
      return sum
    }

    const before = brk(segs.map((s) => ({ ...s })))
    const { record } = collect()
    temper(design, record)
    const after = brk((design.shapes[0] as { segments: Seg[] }).segments)

    expect(after).toBeLessThanOrEqual(before + (1.01 * Math.PI) / 180)
  })

  it('ほぼ円の輪郭は、円そのものに置き換わる', () => {
    // 真円から 4% ずらした輪郭。円のつもりで描かれたものは円にする
    const n = 16
    const segs: Seg[] = Array.from({ length: n }, (_, i) => {
      const t = ((i + 1) / n) * Math.PI * 2
      const r = 1 + (i % 2 === 0 ? 0.04 : -0.04)
      return { x: r * Math.cos(t), y: r * Math.sin(t), r: 1.05, sweep: true }
    })
    const design = designWith([segs])
    const { notes, record } = collect()
    temper(design, record)

    expect(design.shapes[0].kind).toBe('circle')
    const c = design.shapes[0] as unknown as { r: number; pinned?: boolean }
    expect(c.r).toBeCloseTo(1, 1)
    // 置いた位置がそのまま答え。この後の座標スナップで動かされては困る
    expect(c.pinned).toBe(true)
    expect(notes.some((x) => x.field === '円へ整形')).toBe(true)
  })

  it('円と言えない形は輪郭のまま（卵や角丸は潰さない）', () => {
    const design = designWith([ring(1, 16, 1.2, 0, 0, 0.6)])
    const { record } = collect()
    temper(design, record)
    expect(design.shapes[0].kind).toBe('contour')
  })

  it('手描き（freehand）は規則へ寄せない', () => {
    const n = 16
    const segs: Seg[] = Array.from({ length: n }, (_, i) => {
      const t = ((i + 1) / n) * Math.PI * 2
      return { x: Math.cos(t), y: Math.sin(t), r: 1, sweep: true }
    })
    const design = { ...designWith([segs]), freehand: true } as LogoDesign
    const { record } = collect()
    temper(design, record)
    // 筆致のゆらぎは表現そのもの。円に潰さない
    expect(design.shapes[0].kind).toBe('contour')
  })

  it('点が 3 つでも、輪郭として円なら円にする', () => {
    // 環に並ぶ小さな点は 3〜4 点で当てはまる。アンカーだけ見ていた頃は
    // 円にならず、角の残った塊のまま残っていた
    const R = 0.12
    const segs: Seg[] = Array.from({ length: 3 }, (_, i) => {
      const t = ((i + 1) / 3) * Math.PI * 2
      return { x: R * Math.cos(t), y: R * Math.sin(t), r: R, sweep: true }
    })
    const design = designWith([segs])
    const { record } = collect()
    temper(design, record)
    expect(design.shapes[0].kind).toBe('circle')
  })

  it('三角形は円にしない（頂点だけ見ると円が通ってしまう）', () => {
    // 3 頂点にはかならず外接円が通る。辺が直線なら、それは円ではない
    const R = 0.5
    const segs: Seg[] = Array.from({ length: 3 }, (_, i) => {
      const t = ((i + 1) / 3) * Math.PI * 2
      return { x: R * Math.cos(t), y: R * Math.sin(t), sweep: true }
    })
    const design = designWith([segs])
    const { record } = collect()
    temper(design, record)
    expect(design.shapes[0].kind).toBe('contour')
  })

  it('輪郭を含まない設計には何もしない', () => {
    const design = {
      name: 'x',
      concept: '',
      module: 64,
      grid: 'golden',
      palette: { ink: '#000', background: '#fff' },
      shapes: [{ kind: 'circle', id: 'c', cx: 1, cy: 2, r: 3 }],
      constraints: [],
      groups: [],
      parts: [],
    } as unknown as LogoDesign
    const { notes, record } = collect()
    temper(design, record)
    expect(notes).toHaveLength(0)
    expect((design.shapes[0] as { cx: number }).cx).toBe(1)
  })
})
