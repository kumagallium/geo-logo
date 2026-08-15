import { describe, expect, it } from 'vitest'
import { build } from './build'
import { designSchema } from './dsl'
import { buildFromFigure, resolveFigureForm, type FigurePlan } from './figure'
import { measure, strokesOf, distinctCount } from './metrics'
import { normalize } from './normalize'

const base = (nodes: FigurePlan['nodes']): FigurePlan =>
  ({ name: '検査', concept: '検査', ratio: 'golden', pen: 'regular', nodes }) as FigurePlan

const centerOf = (design: ReturnType<typeof buildFromFigure>, id: string) => {
  const s = design.shapes.find((x) => x.id === id)
  if (!s || !('cx' in s) || !('r' in s)) throw new Error(`${id} が無い`)
  return { x: s.cx, y: s.cy, r: s.r }
}

describe('関係で置く', () => {
  /**
   * 接は 1 点でしか触れないので、線 1 本ぶん食い込ませてある（BITE）。
   * 「半径の和ちょうど」ではなく「和より線 1 本ぶんだけ内側」を確かめる。
   */
  const pen = (d: ReturnType<typeof buildFromFigure>) => {
    const w = strokesOf(d)[0]
    // 線を持つシェイプが無い設計ではペン幅が出ないので、外接半径から逆算する
    return w ?? 0
  }

  it('outside は半径の和より線 1 本ぶん内側に置く', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'disc', on: 'a', grip: 'outside', at: 0, size: 0.5 },
        { id: 'w', form: 'ring', on: 'a', grip: 'center', size: 2 },
      ] as never),
    )
    const a = centerOf(d, 'a')
    const b = centerOf(d, 'b')
    const gap = a.r + b.r - Math.hypot(b.x - a.x, b.y - a.y)
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeCloseTo(pen(d) * 0.6, 2)
  })

  it('inside は半径の差より線 1 本ぶん外側に置く', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'disc', on: 'a', grip: 'inside', at: 90, size: 0.5 },
        { id: 'w', form: 'ring', on: 'a', grip: 'center', size: 2 },
      ] as never),
    )
    const a = centerOf(d, 'a')
    const b = centerOf(d, 'b')
    const bite = Math.hypot(b.x - a.x, b.y - a.y) - (a.r - b.r)
    expect(bite).toBeCloseTo(pen(d) * 0.6, 2)
  })

  it('on は中心が親の円周上に乗る', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'disc', on: 'a', grip: 'on', at: 180, size: 0.5 },
      ] as never),
    )
    const a = centerOf(d, 'a')
    const b = centerOf(d, 'b')
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(a.r, 3)
  })

  it('置き方が DSL の制約として出る', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'disc', on: 'a', grip: 'outside', at: 0, size: 0.5 },
        { id: 'c', form: 'disc', on: 'a', grip: 'center', size: 1 },
      ] as never),
    )
    expect(d.constraints).toContainEqual({ type: 'tangent', a: 'b', b: 'a', mode: 'external' })
    expect(d.constraints).toContainEqual({ type: 'concentric', a: 'c', b: 'a' })
  })

  // 制約は中心を持つシェイプにしか張れない。棒に張ると解決できない参照になる
  it('棒には制約を張らない', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'bar', on: 'a', grip: 'on', at: 0, size: 1 },
      ] as never),
    )
    expect(d.constraints.some((c) => JSON.stringify(c).includes('"b"'))).toBe(false)
    expect(normalize(designSchema.parse(d)).unresolved).toEqual([])
  })

  it('存在しない親を指しても落ちない', () => {
    const d = buildFromFigure(
      base([{ id: 'a', form: 'disc', on: 'nowhere', size: 1, x: 0, y: 0 }] as never),
    )
    expect(d.shapes).toHaveLength(1)
  })
})

describe('方角の言葉', () => {
  // 角度の符号と回る向きを間違える出力が多かった。y が下向きだと知らないと
  // 「頭は胴の上」を +90 と書いてしまう
  it('up は上（y が負の側）に置く', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'disc', on: 'a', grip: 'outside', at: 'up', size: 0.5 },
      ] as never),
    )
    expect(centerOf(d, 'b').y).toBeLessThan(-1)
  })

  it('down / left / right も向きが合う', () => {
    const place = (at: string) => {
      const d = buildFromFigure(
        base([
          { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
          { id: 'b', form: 'disc', on: 'a', grip: 'outside', at, size: 0.5 },
        ] as never),
      )
      return centerOf(d, 'b')
    }
    expect(place('down').y).toBeGreaterThan(1)
    expect(place('left').x).toBeLessThan(-1)
    expect(place('right').x).toBeGreaterThan(1)
    expect(place('上').y).toBeLessThan(-1)
  })

  it('鏡像は左右の言葉を入れ替える', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'disc', on: 'a', grip: 'outside', at: 'upleft', size: 0.5, mirror: true },
      ] as never),
    )
    const l = centerOf(d, 'b')
    const r = centerOf(d, 'bM')
    expect(l.x).toBeCloseTo(-r.x, 3)
    expect(l.y).toBeCloseTo(r.y, 3)
    expect(l.y).toBeLessThan(0)
  })

  it('線を親にすると start / middle / end で読む', () => {
    const at = (word: string) => {
      const d = buildFromFigure(
        base([
          { id: 's', form: 'bar', x: 0, y: 0, size: 3, angle: 0 },
          { id: 'b', form: 'disc', on: 's', grip: 'on', at: word, size: 0.4 },
        ] as never),
      )
      return centerOf(d, 'b').x
    }
    expect(at('start')).toBeLessThan(at('middle'))
    expect(at('middle')).toBeLessThan(at('end'))
  })

  it('読めない語は既定へ倒して落ちない', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'b', form: 'disc', on: 'a', grip: 'outside', at: 'somewhere', size: 0.5 },
      ] as never),
    )
    expect(d.shapes).toHaveLength(2)
  })
})

describe('入れ子', () => {
  // 部品方式は「塗りを全部足してから抜く」順に並べ替えるので、環・白・瞳が
  // 作れなかった（白が瞳を消す）。層は宣言順の逐次でなければならない
  it('層が墨・白・墨の順で逐次に出る', () => {
    const d = buildFromFigure(
      base([
        { id: 'e', form: 'disc', x: 0, y: 0, size: 1, layers: ['ink', 'paper', 'ink'] },
      ] as never),
    )
    expect(d.parts[0].steps.map((s) => s.op)).toEqual(['add', 'sub', 'add'])
    const built = build(designSchema.parse(d))
    // 瞳が残っていれば輪郭は 2 本（外周と白の穴）以上になる
    expect(measure(designSchema.parse(d), built).contours).toBeGreaterThanOrEqual(2)
  })

  // 解決ループは親が解けたものから詰めるので、放っておくと兄弟が逆順になり、
  // 節点をまたいだ入れ子（白を敷いてから墨を置く）が成立しない
  it('節点をまたぐ順序も宣言どおりになる', () => {
    const d = buildFromFigure(
      base([
        { id: 'body', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'gap', form: 'bar', on: 'body', grip: 'on', at: 'right', size: 1.4, layers: ['paper'] },
        { id: 'arm', form: 'bar', on: 'body', grip: 'on', at: 'right', size: 1.2 },
      ] as never),
    )
    expect(d.parts[0].steps.map((s) => `${s.op}:${s.ref}`)).toEqual(['add:body', 'sub:gap', 'add:arm'])
  })

  it('層は同心で、半径が階梯で縮む', () => {
    const d = buildFromFigure(
      base([{ id: 'e', form: 'disc', x: 0, y: 0, size: 1.618, layers: ['ink', 'paper'] }] as never),
    )
    const outer = centerOf(d, 'e')
    const inner = centerOf(d, 'eL1')
    expect(inner.x).toBe(outer.x)
    expect(inner.y).toBe(outer.y)
    expect(outer.r / inner.r).toBeCloseTo(1.618, 2)
  })
})

describe('反復', () => {
  it('親の弧に沿って count 個ならぶ', () => {
    const d = buildFromFigure(
      base([
        { id: 's', form: 'arc', x: 0, y: 0, size: 3, angle: -90, span: 120 },
        { id: 'r', form: 'bar', on: 's', grip: 'inside', count: 6, spread: 90, size: 0.8 },
      ] as never),
    )
    expect(d.shapes.filter((s) => s.id.startsWith('r_'))).toHaveLength(6)
  })

  it('taper が端の寸法を変える', () => {
    const d = buildFromFigure(
      base([
        { id: 's', form: 'bar', x: 0, y: 0, size: 3, angle: 0 },
        { id: 'r', form: 'disc', on: 's', count: 5, spread: 100, size: 0.6, taper: 0.5 },
      ] as never),
    )
    const rs = d.shapes.filter((s) => s.id.startsWith('r_')).map((s) => ('r' in s ? s.r : 0))
    // 中央が最も大きく、端が小さい
    expect(rs[2]).toBeGreaterThan(rs[0])
    expect(rs[0]).toBeCloseTo(rs[4], 3)
  })

  it('散らさない反復は同心に外へ重なる', () => {
    const d = buildFromFigure(
      base([
        { id: 'h', form: 'disc', x: 0, y: 0, size: 1 },
        { id: 'w', form: 'arc', on: 'h', grip: 'center', count: 3, size: 1.4, span: 100 },
      ] as never),
    )
    const rs = d.shapes.filter((s) => s.id.startsWith('w_')).map((s) => ('r' in s ? s.r : 0))
    expect(rs).toHaveLength(3)
    expect(rs[0]).toBeLessThan(rs[1])
    expect(rs[1]).toBeLessThan(rs[2])
  })
})

describe('反復の混み合い', () => {
  // 合成形（ヴェシカ・四肢）は複数の円でできている。片方の円にだけ制約を
  // 張ると、ソルバーがそれを親へ引き寄せて 2 円が離れ、交差が空になる
  it('花弁を多数まわりに置いても消えない', () => {
    const d = designSchema.parse(
      buildFromFigure(
        base([
          { id: 'disc', form: 'disc', x: 0, y: 0, size: 2.4 },
          { id: 'petal', form: 'vesica', on: 'disc', grip: 'outside', at: 'up', size: 1.05,
            count: 24, spread: 360 },
        ] as never),
      ),
    )
    const b = build(d)
    expect(b.warnings).toEqual([])
    // 花弁が出ていれば輪郭は円 1 本では済まない
    expect(measure(d, b).vertices).toBeGreaterThan(40)
  })

  // 逃がし方は子と親のどちらが主役かで変わる
  it('親より大きい子は外へ広げる（三つ葉）', () => {
    const d = buildFromFigure(
      base([
        { id: 'core', form: 'disc', x: 0, y: 0, size: 0.4 },
        { id: 'leaf', form: 'vesica', on: 'core', grip: 'on', at: 'up', size: 1.6, count: 3, spread: 360 },
      ] as never),
    )
    const leaf = d.shapes.find((s) => s.id === 'leaf_0a')
    if (!leaf || !('cx' in leaf) || !('r' in leaf)) throw new Error('leaf')
    // 芯 0.4 の円周上ではなく、葉どうしが噛み合う位置まで外へ出る
    expect(Math.hypot(leaf.cx, leaf.cy)).toBeGreaterThan(0.8)
    // 縮められていない。ヴェシカの生成円は半分の長さより大きくなる
    expect(leaf.r).toBeGreaterThan(1.6)
  })

  it('親より小さい子は縮める（向日葵）', () => {
    const d = buildFromFigure(
      base([
        { id: 'disc', form: 'disc', x: 0, y: 0, size: 2.4 },
        { id: 'petal', form: 'vesica', on: 'disc', grip: 'outside', at: 'up', size: 1.05,
          count: 24, spread: 360 },
      ] as never),
    )
    const petal = d.shapes.find((s) => s.id === 'petal_0a')
    if (!petal || !('r' in petal)) throw new Error('petal')
    expect(petal.r).toBeLessThan(1.05)
  })

  it('同心の親でも、散らす反復は散る', () => {
    const d = buildFromFigure(
      base([
        { id: 'hoop', form: 'ring', x: 0, y: 0, size: 2.4 },
        { id: 'twist', form: 'bar', on: 'hoop', grip: 'center', at: 'up', size: 0.35,
          count: 12, spread: 360 },
      ] as never),
    )
    const xs = d.shapes.filter((s) => s.id.startsWith('twist_')).map((s) => ('x1' in s ? s.x1 : 0))
    expect(new Set(xs.map((x) => Math.round(x * 100))).size).toBeGreaterThan(6)
  })
})

describe('ペン', () => {
  // 部品方式は線幅を部品の size から引いていたので、大きい部品と小さい部品で
  // 太さが変わった。家紋も洗練されたロゴも、線幅は図全体で数種しかない
  it('線幅が図全体で 1 種になる', () => {
    const d = buildFromFigure(
      base([
        { id: 'a', form: 'ring', x: 0, y: 0, size: 3 },
        { id: 'b', form: 'arc', on: 'a', grip: 'center', size: 2, span: 200 },
        { id: 'c', form: 'bar', on: 'a', grip: 'on', at: 0, size: 0.6 },
      ] as never),
    )
    expect(distinctCount(strokesOf(d))).toBe(1)
  })

  it('太さの語が幅を変える', () => {
    const widths = (['thin', 'regular', 'bold'] as const).map((pen) => {
      const d = buildFromFigure({
        ...base([{ id: 'a', form: 'ring', x: 0, y: 0, size: 3 }] as never),
        pen,
      })
      return strokesOf(d)[0]
    })
    expect(widths[0]).toBeLessThan(widths[1])
    expect(widths[1]).toBeLessThan(widths[2])
  })
})

describe('ヴェシカの細長さ', () => {
  // 生成円の半径を size とする書き方だと細長さが 1.38:1 に固定され、
  // 向日葵や桜の花弁（実物は 4:1 前後）がどれも豆になる
  const lens = (slender: number) => {
    const d = buildFromFigure(
      base([{ id: 'p', form: 'vesica', x: 0, y: 0, size: 1, angle: 0, slender }] as never),
    )
    const a = d.shapes.find((s) => s.id === 'pa')
    const b = d.shapes.find((s) => s.id === 'pb')
    if (!a || !('cx' in a) || !('r' in a) || !b || !('cy' in b)) throw new Error('lens')
    const off = Math.abs(b.cy - a.cy) / 2
    // 長さは angle 方向、幅はその法線方向
    return { length: Math.sqrt(a.r * a.r - off * off), width: a.r - off }
  }

  it('size が半分の長さになる', () => {
    expect(lens(1.4).length).toBeCloseTo(1, 2)
    expect(lens(4).length).toBeCloseTo(1, 2)
  })

  it('slender が長さ ÷ 幅を決める', () => {
    for (const s of [1.4, 2.5, 4, 6]) {
      const { length, width } = lens(s)
      expect(length / width, `slender ${s}`).toBeCloseTo(s, 1)
    }
  })
})

describe('四肢', () => {
  // 一定の太さの棒では、腕も脚も尾も同じ太さの線になる。太さの違う 2 円を
  // 外接接線で包むと、円と直線だけでテーパーが出る
  it('付け根と先の 2 円を接線で包む', () => {
    const d = buildFromFigure(
      base([
        { id: 'body', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'arm', form: 'limb', on: 'body', grip: 'on', at: 0, size: 0.5, length: 3, tip: 0.4 },
      ] as never),
    )
    const root = centerOf(d, 'arma')
    const tipC = centerOf(d, 'armb')
    expect(tipC.r / root.r).toBeCloseTo(0.4, 2)
    expect(Math.hypot(tipC.x - root.x, tipC.y - root.y)).toBeCloseTo(root.r * 3, 2)
    // 胴は 4 点の多角形（外接接線）
    const hull = d.shapes.find((s) => s.id === 'armc')
    expect(hull?.kind).toBe('poly')
  })

  it('四肢は 1 つのまとまりとして合体する', () => {
    const d = designSchema.parse(
      buildFromFigure(
        base([
          { id: 'body', form: 'disc', x: 0, y: 0, size: 2 },
          { id: 'arm', form: 'limb', on: 'body', grip: 'on', at: 0, size: 0.5, length: 3 },
        ] as never),
      ),
    )
    expect(d.groups.some((g) => g.steps.every((s) => s.op === 'add'))).toBe(true)
    const b = build(d)
    expect(b.warnings).toEqual([])
    // 付け根が胴に乗っているので、墨はひとつながり
    expect(measure(d, b).islands.length).toBeLessThanOrEqual(1)
  })

  it('四肢の別名を拾う', () => {
    for (const word of ['tapered bar', '腕', 'tail', 'horn']) {
      expect(resolveFigureForm(word)).toBe('limb')
    }
    expect(resolveFigureForm('bar')).toBe('bar')
    expect(resolveFigureForm('disc')).toBe('disc')
  })
})

describe('白の縁取り', () => {
  // 洗練された紋章ロゴが例外なく持っている操作。翼と胴、首と胸、花弁と円板の
  // 境目が、どこも同じ太さの白で分かれている。これが無いと部品が黒い塊へ溶ける
  it('太らせた同じ形を先に抜く', () => {
    const d = buildFromFigure(
      base([
        { id: 'body', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'wing', form: 'disc', on: 'body', grip: 'inside', at: 'up', size: 0.8, outline: 1 },
      ] as never),
    )
    expect(d.parts[0].steps.map((s) => `${s.op}:${s.ref}`)).toEqual([
      'add:body',
      'sub:wingO',
      'add:wing',
    ])
    const outer = d.shapes.find((s) => s.id === 'wingO')
    const inner = d.shapes.find((s) => s.id === 'wing')
    if (!outer || !('r' in outer) || !inner || !('r' in inner)) throw new Error('形が無い')
    expect(outer.r).toBeGreaterThan(inner.r)
  })

  it('縁取りの幅は図全体で一定', () => {
    const d = buildFromFigure(
      base([
        { id: 'body', form: 'disc', x: 0, y: 0, size: 2.4 },
        { id: 'a', form: 'disc', on: 'body', grip: 'inside', at: 'up', size: 1.2, outline: 1 },
        { id: 'b', form: 'disc', on: 'body', grip: 'inside', at: 'down', size: 0.4, outline: 1 },
      ] as never),
    )
    const gap = (id: string) => {
      const o = d.shapes.find((s) => s.id === `${id}O`)
      const i = d.shapes.find((s) => s.id === id)
      if (!o || !('r' in o) || !i || !('r' in i)) throw new Error(id)
      return o.r - i.r
    }
    // 半径が 3 倍ちがう 2 つでも、白の幅は同じ
    expect(gap('a')).toBeCloseTo(gap('b'), 6)
  })

  // 縁取りは部品の全周を削るので、食い込みが浅いと接点ごと消えて部品が外れる
  it('縁取りのぶんだけ深く食い込ませる', () => {
    const near = (outline: number) => {
      const d = buildFromFigure(
        base([
          { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
          { id: 'b', form: 'disc', on: 'a', grip: 'outside', at: 'right', size: 0.5, outline },
        ] as never),
      )
      const x = d.shapes.find((s) => s.id === 'b')
      if (!x || !('cx' in x)) throw new Error('b')
      return x.cx
    }
    expect(near(1)).toBeLessThan(near(0))
  })

  it('縁取り 0 なら何も足さない', () => {
    const d = buildFromFigure(
      base([
        { id: 'body', form: 'disc', x: 0, y: 0, size: 2 },
        { id: 'wing', form: 'disc', on: 'body', grip: 'inside', at: 'up', size: 0.8 },
      ] as never),
    )
    expect(d.shapes.some((s) => s.id.endsWith('O'))).toBe(false)
  })
})

describe('鏡像', () => {
  it('mirror が左右対称のマークを作る', () => {
    const d = designSchema.parse(
      buildFromFigure(
        base([
          { id: 'head', form: 'disc', x: 0, y: 0, size: 2 },
          { id: 'ear', form: 'disc', on: 'head', grip: 'outside', at: -140, size: 0.6, mirror: true },
          { id: 'eye', form: 'disc', on: 'head', grip: 'inside', at: -150, size: 0.5, mirror: true },
        ] as never),
      ),
    )
    expect(measure(d, build(d)).mirror).toBeGreaterThan(0.99)
  })

  /**
   * 関係方式は対称を「構成で保証する」ことが売りなので、後段で崩れては意味がない。
   * ソルバーが制約を 1 つずつ即座に適用すると、tangent(eye, head) が head を
   * 動かしてから tangent(eyeM, head) が評価され、左右で違う結果になる。
   */
  it('normalize を通しても対が正確に保たれる', () => {
    const d = designSchema.parse(
      buildFromFigure(
        base([
          { id: 'body', form: 'disc', x: 0, y: 1.9, size: 1.7 },
          { id: 'head', form: 'disc', on: 'body', grip: 'outside', at: 'up', size: 2.1 },
          { id: 'ear', form: 'disc', on: 'head', grip: 'outside', at: 'upleft', size: 0.6, mirror: true },
          { id: 'eye', form: 'disc', on: 'head', grip: 'inside', at: 'upleft', size: 0.85,
            layers: ['ink', 'paper', 'ink'], mirror: true },
          { id: 'nose', form: 'disc', on: 'head', grip: 'inside', at: 'down', size: 0.45 },
        ] as never),
      ),
    )
    const out = normalize(d).design
    const byId = new Map(out.shapes.map((s) => [s.id, s]))
    let pairs = 0
    for (const s of out.shapes) {
      const m = byId.get(`${s.id}M`)
      if (!m || !('cx' in s) || !('cx' in m)) continue
      pairs++
      expect(m.cx, `${s.id} の対の x`).toBeCloseTo(-s.cx, 6)
      expect(m.cy, `${s.id} の対の y`).toBeCloseTo(s.cy, 6)
    }
    expect(pairs).toBeGreaterThanOrEqual(2)
  })

  it('鏡像側の子は鏡像側の親に付く', () => {
    const d = buildFromFigure(
      base([
        { id: 'head', form: 'disc', on: 'x', size: 2, x: 0, y: 0 },
        { id: 'arm', form: 'disc', on: 'head', grip: 'outside', at: 0, size: 0.5, mirror: true },
      ] as never),
    )
    // 親が鏡像を持たないので、鏡像側の子も同じ親に付く。左右にそろう
    const a = centerOf(d, 'arm')
    const b = centerOf(d, 'armM')
    expect(a.x).toBeCloseTo(-b.x, 3)
    expect(a.y).toBeCloseTo(b.y, 3)
  })
})

describe('総当たり', () => {
  // 破綻は「警告なし・空でない・潰れていない」で機械判定する
  it('置き方と形の組み合わせで図形が壊れない', () => {
    for (const form of ['disc', 'ring', 'arc', 'bar', 'vesica'] as const) {
      for (const grip of ['on', 'outside', 'inside', 'center'] as const) {
        const d = designSchema.parse(
          buildFromFigure(
            base([
              { id: 'a', form: 'disc', x: 0, y: 0, size: 2 },
              { id: 'b', form, on: 'a', grip, at: -60, size: 0.9, span: 120 },
            ] as never),
          ),
        )
        const built = build(d)
        expect(built.parts.length, `${form}/${grip}`).toBeGreaterThan(0)
        expect(built.warnings, `${form}/${grip}`).toEqual([])
        expect(built.inkRatio, `${form}/${grip}`).toBeGreaterThan(0.05)
      }
    }
  })
})
