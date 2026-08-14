import { describe, expect, it } from 'vitest'
import {
  FORMS,
  buildFromComposition,
  compositionSchema,
  pieceSchema,
  repairConnectivity,
  repairVisibility,
  resolveForm,
  snapToAxis,
  type Piece,
} from './composition'
import { compile } from './index'

const piece = (over: Partial<Piece> & { x: number; y: number; size: number }): Piece =>
  pieceSchema.parse({ form: 'disc', role: 'add', ...over })

describe('resolveForm', () => {
  it('別名を既知の形へ寄せる', () => {
    expect(resolveForm('circle')).toBe('disc')
    expect(resolveForm('Leaf')).toBe('vesica')
    expect(resolveForm('curve')).toBe('arc')
    expect(resolveForm('line')).toBe('bar')
    expect(resolveForm('donut')).toBe('ring')
  })

  it('解決できない語は disc へ倒す（検証で落とさない）', () => {
    // 却下すると再試行になり API コストが倍になる。既定値へ倒すほうが安い。
    expect(resolveForm('gorilla-head')).toBe('disc')
    expect(resolveForm('')).toBe('disc')
  })
})

describe('repairConnectivity', () => {
  it('離れた部品を重なるまで寄せる', () => {
    const pieces = [piece({ x: 0, y: 0, size: 2 }), piece({ x: 9, y: 0, size: 1 })]
    const { pieces: fixed, moved } = repairConnectivity(pieces)

    expect(moved).toBeGreaterThan(0)
    const gap = Math.hypot(fixed[0].x - fixed[1].x, fixed[0].y - fixed[1].y) - (2 + 1)
    expect(gap).toBeLessThan(0)
  })

  it('既に重なっているものは動かさない', () => {
    const pieces = [piece({ x: 0, y: 0, size: 2 }), piece({ x: 1, y: 0, size: 1 })]
    const { pieces: fixed, moved } = repairConnectivity(pieces)
    expect(moved).toBe(0)
    expect(fixed).toEqual(pieces)
  })

  it('成分ごと動かすので、まとまっている関係は壊れない', () => {
    // 右側の 2 つは重なっている。左の大きな円へ寄せても相対位置は保たれる。
    // 座標はスキーマで ±6 に clamp されるので、範囲内に収めること
    const pieces = [
      piece({ x: 0, y: 0, size: 2.5 }),
      piece({ x: 5, y: 0, size: 1 }),
      piece({ x: 5.6, y: 0, size: 1 }),
    ]
    const { pieces: fixed } = repairConnectivity(pieces)
    expect(fixed[2].x - fixed[1].x).toBeCloseTo(0.6, 6)
    expect(fixed[2].y - fixed[1].y).toBeCloseTo(0, 6)
  })

  it('同心でも方向が決まらず止まることがない', () => {
    // 大きな円の中心にある小さな円は、方向ベクトルが定まらない
    const pieces = [piece({ x: 0, y: 0, size: 3 }), piece({ x: 0, y: 0, size: 0.2 })]
    expect(() => repairConnectivity(pieces)).not.toThrow()
  })
})

describe('repairVisibility', () => {
  it('埋もれた塗り部品を輪郭の外まで押し出す', () => {
    // 半径 3 の円の中心付近にある小円は、合体すると消える
    const pieces = [piece({ x: 0, y: 0, size: 3 }), piece({ x: 0, y: 0.5, size: 0.8 })]
    const { pieces: fixed, moved } = repairVisibility(pieces)

    expect(moved).toBeGreaterThan(0)
    const reach = Math.hypot(fixed[1].x - fixed[0].x, fixed[1].y - fixed[0].y) + fixed[1].size
    expect(reach).toBeGreaterThan(3)
  })

  it('押し出しても土台との重なりは保つ', () => {
    const pieces = [piece({ x: 0, y: 0, size: 3 }), piece({ x: 0, y: 0.5, size: 0.8 })]
    const { pieces: fixed } = repairVisibility(pieces)
    const d = Math.hypot(fixed[1].x - fixed[0].x, fixed[1].y - fixed[0].y)
    expect(d).toBeLessThan(3 + 0.8)
  })

  it('抜き部品は埋もれたままにする（内側の造形は cut で作るため）', () => {
    const pieces = [
      piece({ x: 0, y: 0, size: 3 }),
      piece({ x: 0, y: 0.5, size: 0.5, role: 'cut' }),
    ]
    const { pieces: fixed, moved } = repairVisibility(pieces)
    expect(moved).toBe(0)
    expect(fixed[1]).toEqual(pieces[1])
  })

  it('土台そのものは動かさない', () => {
    const pieces = [piece({ x: 0, y: 0, size: 3 }), piece({ x: 3.4, y: 0, size: 0.8 })]
    const { pieces: fixed } = repairVisibility(pieces)
    expect(fixed[0]).toEqual(pieces[0])
  })
})

describe('buildFromComposition', () => {
  it('左右対称の部品を反転して複製する', () => {
    const design = buildFromComposition({
      name: 'T',
      concept: 'c',
      ratio: 'golden',
      pieces: [
        { x: 0, y: 0, size: 2 },
        { x: 1.6, y: -1.2, size: 0.6, mirror: true },
      ],
    } as never)
    // 土台 1 + 対の 2
    expect(design.shapes).toHaveLength(3)
    const xs = design.shapes.map((s) => ('cx' in s ? s.cx : 0)).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(-xs[2], 6)
  })

  it('x=0 の部品は反転しても同じ位置なので複製しない', () => {
    const design = buildFromComposition({
      name: 'T',
      concept: 'c',
      ratio: 'golden',
      pieces: [{ x: 0, y: 0, size: 2, mirror: true }],
    } as never)
    expect(design.shapes).toHaveLength(1)
  })

  it('抜きしか無くても塗りが 1 つ生まれる', () => {
    // 最初の演算が sub だと何も生まれない。却下せず最大の部品を塗りへ倒す。
    const result = compile(
      buildFromComposition({
        name: 'T',
        concept: 'c',
        ratio: 'golden',
        pieces: [
          { x: 0, y: 0, size: 2, role: 'cut' },
          { x: 0.5, y: 0, size: 0.4, role: 'cut' },
        ],
      } as never),
    )
    expect(result.built.parts.length).toBeGreaterThan(0)
    expect(result.built.parts[0].pathData).not.toBe('')
  })

  it('知らない語や欠けた値が来ても組み立てられる', () => {
    const design = buildFromComposition({
      name: 'T',
      concept: 'c',
      ratio: 'なんとなく金色',
      pieces: [
        { label: '頭', form: 'gorilla-head', role: 'めっちゃ足す', x: 0, y: 0, size: 2 },
        { form: null, x: '1.5', y: null, size: 0.7 },
      ],
    } as never)
    expect(design.shapes.length).toBeGreaterThan(0)
    expect(design.grid).toBe('golden')
  })

  it('範囲外の数値は落とさず clamp する', () => {
    const p = pieceSchema.parse({ form: 'disc', x: 999, y: -999, size: 0 })
    expect(p.x).toBe(6)
    expect(p.y).toBe(-6)
    expect(p.size).toBe(0.15)
  })
})

/** 決定的な擬似乱数（テストを再現可能にする） */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('でたらめな配置でも構成として成立する', () => {
  /**
   * 部品方式の要点は「モデルは大まかに置くだけでよい」こと。
   * それが本当かは、意味のない配置を大量に流して確かめるしかない。
   *
   * 主張するのは幾何の成立だけ（形が浮かない・塗りが生まれる）。
   * 美しさは機械判定できないので候補から人が選ぶ、という分担は変えない。
   */
  it('浮いた要素が出ず、必ず塗りが生まれる', () => {
    const rand = lcg(20260814)
    let checked = 0

    for (let trial = 0; trial < 120; trial++) {
      const n = 1 + Math.floor(rand() * 6)
      const pieces = Array.from({ length: n }, () => ({
        form: FORMS[Math.floor(rand() * FORMS.length)],
        role: rand() < 0.25 ? 'cut' : 'add',
        // わざと散らす。修復が効かなければバラバラのマークになる
        x: (rand() - 0.5) * 10,
        y: (rand() - 0.5) * 10,
        size: 0.2 + rand() * 2.5,
        angle: Math.floor(rand() * 360),
        span: 30 + Math.floor(rand() * 300),
        mirror: rand() < 0.4,
      }))

      const design = buildFromComposition(
        compositionSchema.parse({ name: 'T', concept: 'c', ratio: 'golden', pieces }),
      )
      const result = compile(design)

      expect(result.built.unrelated, `trial ${trial}: ${JSON.stringify(pieces)}`).toEqual([])
      expect(result.built.parts.length, `trial ${trial}`).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBe(120)
    // 120 通りのブーリアン演算は既定の 5 秒に収まらない。手元では約 2 秒だが、
    // CI のランナーはもっと遅く、実際に超えて落ちた。
  }, 60_000)
})

const base = {
  label: '',
  form: 'disc' as const,
  role: 'add' as const,
  x: 0,
  y: 0,
  size: 1,
  angle: 0,
  span: 180,
  thickness: 'regular' as const,
  mirror: false,
}

describe('軸へ寄せる', () => {
  // 「ほとんど対称、でも少しずれている」は、対称でも非対称でもない
  // 中途半端な見え方になり、どちらより悪い。
  it('軸の近くの部品は軸に乗る', () => {
    const out = snapToAxis([
      { ...base, x: 0.06, y: 0, size: 2 },
      { ...base, x: 1.8, y: 0.5, size: 0.6 },
    ])
    expect(out[0].x).toBe(0)
    expect(out[1].x).toBe(1.8)
  })

  it('鏡の相手どうしが正確に揃う', () => {
    const out = snapToAxis([
      { ...base, x: 0, y: 0, size: 2 },
      { ...base, x: 1.2, y: 0.4, size: 0.5 },
      { ...base, x: -1.14, y: 0.46, size: 0.54 },
    ])
    expect(out[1].x).toBe(-out[2].x)
    expect(out[1].y).toBe(out[2].y)
    expect(out[1].size).toBe(out[2].size)
  })

  it('明らかに対応しない部品は動かさない', () => {
    const out = snapToAxis([
      { ...base, x: 0, y: 0, size: 3 },
      { ...base, x: 2.4, y: -1.5, size: 0.4 },
      { ...base, x: -2.3, y: 1.9, size: 1.6 },
    ])
    expect(out[1].y).toBe(-1.5)
    expect(out[2].size).toBe(1.6)
  })
})
