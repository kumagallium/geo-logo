import { describe, expect, it } from 'vitest'
import type { LogoDesign } from './dsl'
import { temper, type Recorder } from './temper'
import { PHI } from './units'

/**
 * 計測は「測って言う」だけの工程。**絵を動かさない**ことと、
 * 言っていることが本当であることの両方を固定する。
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
    parts: [
      {
        id: 'p',
        steps: segments.map((_, i) => ({ op: 'add' as const, ref: `r${i}` })),
        fill: 'ink',
        mirror: 'none' as const,
      },
    ],
  } as unknown as LogoDesign
}

const collect = () => {
  const notes: Array<{ id: string; field: string; from: number; label: string | null }> = []
  const record: Recorder = (id, field, from, _to, label) => notes.push({ id, field, from, label })
  return { notes, record }
}

/** 円周上に n 点を置き、弧半径 r で結んだ輪郭 */
function ring(R: number, n: number, r: number, cx = 0, cy = 0, sy = 1): Seg[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2
    return { x: cx + R * Math.cos(t), y: cy + R * sy * Math.sin(t), r }
  })
}

describe('計測', () => {
  it('絵を一切動かさない', () => {
    // 寄せたくなる形（ほぼ真円・ほぼ φ）を渡しても、座標も半径も変わらないこと
    const design = designWith([ring(1, 16, 1.02), ring(0.3, 8, 0.31, 2, 0)])
    const before = JSON.stringify(design.shapes)
    const { record } = collect()
    temper(design, record)
    expect(JSON.stringify(design.shapes)).toBe(before)
    // 種類も変わらない（円へ置き換えたりしない）
    for (const s of design.shapes) expect(s.kind).toBe('contour')
  })

  it('真円からのずれを測る', () => {
    const n = 16
    const segs: Seg[] = Array.from({ length: n }, (_, i) => {
      const t = ((i + 1) / n) * Math.PI * 2
      const r = 1 + (i % 2 === 0 ? 0.04 : -0.04)
      return { x: r * Math.cos(t), y: r * Math.sin(t), r: 1.05, sweep: true }
    })
    const { notes, record } = collect()
    temper(designWith([segs]), record)

    const hit = notes.find((n2) => n2.field === '真円からのずれ')
    expect(hit).toBeDefined()
    expect(hit!.from).toBeGreaterThan(0.02)
    expect(hit!.from).toBeLessThan(0.1)
  })

  it('一周していない小片を円として報告しない', () => {
    // 浅い弧は大きな円の上にきれいに乗るが、それは円ではない
    const arc: Seg[] = Array.from({ length: 8 }, (_, i) => {
      const t = (i / 7) * 0.5 // 全周のごく一部だけ
      return { x: Math.cos(t) * 3, y: Math.sin(t) * 3, r: 3, sweep: true }
    })
    const { notes, record } = collect()
    temper(designWith([arc]), record)
    expect(notes.some((n) => n.field === '真円からのずれ')).toBe(false)
  })

  it('縦横比を測り、正準比に近いときだけ名前を添える', () => {
    const near = collect()
    temper(designWith([ring(0.8, 12, 0.9, 0, 0, 1 / PHI)]), near.record)
    const a = near.notes.find((n) => n.field === '縦横比')
    expect(a?.from).toBeCloseTo(PHI, 1)
    expect(a?.label).toBe('1:φ')

    const far = collect()
    temper(designWith([ring(0.8, 12, 0.9, 0, 0, 1 / 1.3)]), far.record)
    const b = far.notes.find((n) => n.field === '縦横比')
    expect(b?.from).toBeCloseTo(1.3, 1)
    // 近くない比に名前を付けると、設計図が嘘をつく
    expect(b?.label).toBeNull()
  })

  it('重心と枠中心のずれを測る（動かさずに）', () => {
    // 右に小さな塊を足すと、重心は枠の中心より右へ寄る
    const design = designWith([ring(1, 12, 1.1), ring(0.35, 8, 0.4, 1.6, 0)])
    const before = JSON.stringify(design.shapes)
    const { notes, record } = collect()
    temper(design, record)
    const hit = notes.find((n) => n.field === '重心と枠中心のずれ')
    expect(hit).toBeDefined()
    expect(hit!.from).toBeGreaterThan(0)
    expect(JSON.stringify(design.shapes)).toBe(before)
  })

  it('半径の種類を数える', () => {
    const { notes, record } = collect()
    temper(designWith([ring(1, 8, 1), ring(0.3, 8, 0.3, 2, 0)]), record)
    const hit = notes.find((n) => n.field === '半径の種類')
    expect(hit?.from).toBe(2)
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
  })
})
