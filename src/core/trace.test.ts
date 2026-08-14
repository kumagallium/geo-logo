import { describe, expect, it } from 'vitest'
import { compile } from './index'
import {
  allocateArcs,
  collectShapes,
  contourComplexity,
  fitToModule,
  nestingDepth,
  paintOf,
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
    // 同じ円は 1 度しか描かない。円弧は 180 度を超えられないので 1 つの円が
    // 複数の弧に割れ、素朴に描くと同じ円が重なって線が数倍になる
    const circles = result.built.construction.filter((c) => c.kind === 'circle')
    expect(circles.length).toBeGreaterThanOrEqual(1)
    expect(circles.length).toBeLessThan(segments.length)
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
    const pts = sampleContoursFromSvg(svg, 60)[0].points
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

describe('collectShapes', () => {
  it('祖先の transform を解決する', () => {
    // 要素ごとに別々の変換を持つ素材（Inkscape 製の家紋など）で、
    // 無視すると図形が離れた場所へ散らばる
    const svg =
      '<svg><g transform="translate(10,0)"><g transform="scale(2)">' +
      '<path d="M 0 0 L 1 0 L 1 1 Z"/></g></g></svg>'
    const [shape] = collectShapes(svg)
    expect(shape.matrix).toEqual([2, 0, 0, 2, 10, 0])
  })

  it('描画されない要素の中身は拾わない', () => {
    // clipPath の中の図形を実体として拾うと、切り抜きの型が紋を塗り潰す
    const svg =
      '<svg><clipPath id="x"><path d="M 0 0 L 9 0 L 9 9 Z"/></clipPath>' +
      '<defs><path d="M 0 0 L 5 0 L 5 5 Z"/></defs>' +
      '<path d="M 0 0 L 1 0 L 1 1 Z"/></svg>'
    expect(collectShapes(svg)).toHaveLength(1)
  })

  it('塗りを親から継承する', () => {
    // <svg fill="none" stroke="#000"> で線だけ描いた紋を、塗り指定なし＝黒と
    // 誤解すると真っ黒な円板になる
    const svg = '<svg fill="none"><circle cx="5" cy="5" r="4"/></svg>'
    expect(collectShapes(svg)).toHaveLength(0)
  })
})

describe('paintOf', () => {
  it('明るい色は塗り消しとして扱う', () => {
    // 黒地に白抜きで紋を描いた反転素材がある
    expect(paintOf('<path fill="#ffffff"/>')).toBe('erase')
    expect(paintOf('<path fill="white"/>')).toBe('erase')
    expect(paintOf('<path fill="#000000"/>')).toBe('ink')
    expect(paintOf('<path fill="rgb(20,20,20)"/>')).toBe('ink')
  })

  it('塗り指定が無ければ黒（SVG の既定）', () => {
    expect(paintOf('<path d="M0 0"/>')).toBe('ink')
  })

  it('none と透明は無視する', () => {
    expect(paintOf('<path fill="none"/>')).toBe('skip')
    expect(paintOf('<path fill="#000" fill-opacity="0"/>')).toBe('skip')
    expect(paintOf('<path style="display:none" fill="#000"/>')).toBe('skip')
  })

  it('継承した塗りを使う', () => {
    expect(paintOf('<circle r="4"/>', 'none')).toBe('skip')
    expect(paintOf('<circle r="4"/>', '#fff')).toBe('erase')
    // 自身の指定は継承より優先する
    expect(paintOf('<circle r="4" fill="#000"/>', '#fff')).toBe('ink')
  })
})

describe('直線の扱い', () => {
  /**
   * 半径や行列式の大きさで直線かどうかを判定してはいけない。丸め誤差で
   * わずかに非直線になった点列に、最小二乗が極小半径のでたらめな円を返す。
   * そのずれで窓が伸びず、菱形が団子になった（実測: 武田菱が 85 本の円弧に）。
   */
  it('多角形は円弧ではなく直線で表される', () => {
    // 菱形を 4 辺ぶんサンプリング
    const corners = [
      { x: 0, y: -2 },
      { x: 3, y: 0 },
      { x: 0, y: 2 },
      { x: -3, y: 0 },
    ]
    const points: Vec[] = []
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i]
      const b = corners[(i + 1) % corners.length]
      for (let t = 0; t < 60; t++) {
        points.push({ x: a.x + ((b.x - a.x) * t) / 60, y: a.y + ((b.y - a.y) * t) / 60 })
      }
    }

    const { segments } = traceArcs(points, { maxArcs: 12, snapRadii: false })
    expect(segments).toHaveLength(4)
    for (const s of segments) expect(s.r).toBeUndefined()
  })

  it('本物の円は直線に倒れない', () => {
    const { segments } = traceArcs(circlePoints(3), { maxArcs: 10, snapRadii: false })
    for (const s of segments) expect(s.r).toBeDefined()
  })
})

describe('nestingDepth', () => {
  /**
   * 用途は演算の順序決め。外側から順に足し引きしないと、穴を抜いた時点で
   * その中にある実体まで消える（実測: 蛇の目の中心の点が消えた）。
   */
  it('入れ子の段数を数える', () => {
    const outer = circlePoints(10)
    const hole = circlePoints(6)
    const dot = circlePoints(2)
    expect(nestingDepth([outer, hole, dot])).toEqual([0, 1, 2])
  })

  it('離れた輪郭はどちらも 0 段', () => {
    expect(nestingDepth([circlePoints(2, 90, -8, 0), circlePoints(2, 90, 8, 0)])).toEqual([0, 0])
  })
})
