import { describe, expect, it } from 'vitest'
import { compile } from './index'
import {
  allocateArcs,
  collectShapes,
  contourComplexity,
  fitToModule,
  harmonizeRadii,
  mirrorAxis,
  mirrorPairs,
  mirrorSegments,
  nestingDepth,
  paintOf,
  parseTransform,
  sampleContours,
  sampleContoursFromSvg,
  traceArcs,
  type ContourSegment,
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

    // 対称処理は別に検証する。ここでは直線化そのものを見たいので切る
    const { segments } = traceArcs(points, { maxArcs: 12, snapRadii: false, symmetry: false })
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

describe('対称性を保った当てはめ', () => {
  /**
   * 形が対称でも、当てはめを左右で独立に行えばアンカーの位置も半径も食い違う。
   * 完成形の見た目にはほとんど出ないが、作図としては別物になる。
   * 実測（丸に十字）: 鏡像一致 69%、対応する円弧の半径が最大 73 倍ずれていた。
   */
  const symmetric = (n = 240): Vec[] =>
    Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2
      // 上下で膨らみが違う、左右対称な形
      const r = 2 + 0.5 * Math.cos(t * 2) + 0.3 * Math.sin(t) ** 2
      return { x: Math.cos(t) * r, y: Math.sin(t) * r }
    })

  it('左右対称な輪郭を軸として検出する', () => {
    expect(mirrorAxis(symmetric())).toBeCloseTo(0, 1)
  })

  it('非対称な輪郭では検出しない', () => {
    const skewed = symmetric().map((p) => ({ x: p.x + p.y * 0.4, y: p.y }))
    expect(mirrorAxis(skewed)).toBeNull()
  })

  it('軸を指定でき、そこで対称でなければ検出しない', () => {
    // 十字の抜きのように、自分の中心では対称に見えてもマークの軸では非対称、
    // という要素がある。軸はマーク全体で 1 つに決める
    const offset = symmetric().map((p) => ({ x: p.x + 6, y: p.y }))
    expect(mirrorAxis(offset, 6)).toBeCloseTo(6, 1)
    expect(mirrorAxis(offset, 0)).toBeNull()
  })

  it('対称な輪郭では、弧が厳密に鏡像になる', () => {
    // 半径は「その点へ入る弧」に属する。鏡像では入りと出が入れ替わるので、
    // 対応する点どうしで半径を比べても一致しない。弧（始点・終点・半径）で比べる
    const { segments } = traceArcs(symmetric(), { maxArcs: 20 })
    const arcs = segments.map((g, i) => {
      const from = segments[(i - 1 + segments.length) % segments.length]
      return { x1: from.x, y1: from.y, x2: g.x, y2: g.y, r: g.r ?? 0 }
    })

    const near = (a: number, b: number) => Math.abs(a - b) < 1e-3
    for (const a of arcs) {
      // 鏡像の弧は、始点と終点が入れ替わった形で現れる
      const partner = arcs.find(
        (b) =>
          near(b.x1, -a.x2) && near(b.y1, a.y2) && near(b.x2, -a.x1) && near(b.y2, a.y1) &&
          near(b.r, a.r),
      )
      expect(partner, `(${a.x1},${a.y1})→(${a.x2},${a.y2}) r=${a.r} の鏡像が無い`).toBeDefined()
    }
  })

  it('symmetry を切れば従来どおり左右独立で当てはめる', () => {
    const on = traceArcs(symmetric(), { maxArcs: 20 })
    const off = traceArcs(symmetric(), { maxArcs: 20, symmetry: false })
    expect(on.segments).not.toEqual(off.segments)
  })
})

describe('mirrorPairs', () => {
  /**
   * 自分自身が対称な要素だけ揃えても足りない。十字の 4 つの抜きのように、
   * 個々は非対称でも対で鏡像になっている要素がある。
   * 実測（丸に十字）: 対まで揃えて弧の鏡像一致 34% → 100%。
   */
  /** それ自体は左右対称でない形（位相をずらしてある） */
  const blob = (cx: number): Vec[] =>
    Array.from({ length: 160 }, (_, i) => {
      const t = (i / 160) * Math.PI * 2
      const r = 1 + 0.4 * Math.sin(t * 3 + 0.7)
      return { x: cx + Math.cos(t) * r, y: Math.sin(t) * r }
    })

  const mirrored = (c: Vec[], axis: number) => c.map((q) => ({ x: 2 * axis - q.x, y: q.y }))
  const rotated = (c: Vec[], cx: number) => c.map((q) => ({ x: 2 * cx - q.x, y: -q.y }))

  it('軸をはさんで鏡像になっている輪郭を対にする', () => {
    expect(mirrorPairs([blob(-3), mirrored(blob(-3), 0)], 0)).toEqual([1, 0])
  })

  it('外接枠が合っていても形が鏡像でなければ対にしない', () => {
    // 二つ巴の 2 つの巴は鏡像ではなく 180 度回転。枠は一致するが形は反転して
    // いない。誤って対とみなすと形が壊れる（実測: 一致率 99.8% → 69%）
    expect(mirrorPairs([blob(-3), rotated(blob(-3), 3)], 0)).toEqual([null, null])
  })

  it('自分自身が対称なものは対にしない', () => {
    const centred = Array.from({ length: 120 }, (_, i) => {
      const t = (i / 120) * Math.PI * 2
      return { x: Math.cos(t) * 2, y: Math.sin(t) * 2 }
    })
    expect(mirrorPairs([centred], 0)).toEqual([null])
  })
})

describe('mirrorSegments', () => {
  it('反転しても回る向きは変わらない', () => {
    // 鏡像で 1 度、逆順に辿ることでもう 1 度反転し、打ち消し合う
    const segs = traceArcs(circlePoints(2), { maxArcs: 8, snapRadii: false }).segments
    const flipped = mirrorSegments(segs, 0)
    expect(flipped).toHaveLength(segs.length)
    expect(flipped.map((s) => s.sweep).sort()).toEqual(segs.map((s) => s.sweep).sort())
    // 半径の集合は保たれる
    expect(flipped.map((s) => s.r).sort()).toEqual(segs.map((s) => s.r).sort())
  })

  it('二度反転すると元に戻る', () => {
    const segs = traceArcs(circlePoints(2), { maxArcs: 8, snapRadii: false }).segments
    const back = mirrorSegments(mirrorSegments(segs, 0), 0)
    for (const s of back) {
      expect(segs.some((t) => Math.abs(t.x - s.x) < 1e-6 && Math.abs(t.y - s.y) < 1e-6)).toBe(true)
    }
  })
})

describe('線端の扱い', () => {
  /**
   * SVG の既定の線端は butt（端を伸ばさない）。丸く塞ぐと線が両端で半径ぶん
   * 伸び、空いているべき隙間が埋まる（実測: 丸に竪三つ引で縦棒が輪に接した）。
   */
  const bar = (cap: string) =>
    `<svg><path fill="none" stroke="#000" stroke-width="4"${cap} d="M 10 10 L 10 30"/></svg>`

  it('既定では線が伸びない', () => {
    const pts = sampleContoursFromSvg(bar(''), 240)[0].points
    const ys = pts.map((q) => q.y)
    // 元の線は y=10〜30。butt なら高さは 20 のまま
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 0)
  })

  it('round を指定すると両端が半径ぶん伸びる', () => {
    const pts = sampleContoursFromSvg(bar(' stroke-linecap="round"'), 240)[0].points
    const ys = pts.map((q) => q.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(24, 0)
  })

  it('線の太さは保たれる', () => {
    const pts = sampleContoursFromSvg(bar(''), 240)[0].points
    const xs = pts.map((q) => q.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 0)
  })
})

describe('harmonizeRadii', () => {
  /**
   * 「円弧が体系に載っていない」という批評への答え。外部の比例体系へ寄せると
   * 形が壊れるが、それは体系が形より後に来ているから。マーク自身が使っている
   * 半径を数え上げて代表値へ寄せれば、体系は押しつけではなく取り出しになる。
   * 実測（二つ巴）: 円弧 24 本が半径 5 種に収まり、一致率は 99.83% → 99.81%。
   */
  const seg = (r: number): ContourSegment => ({ x: 0, y: 0, r, sweep: true })

  it('近い半径を代表値へまとめる', () => {
    const { groups, radii } = harmonizeRadii([[seg(2.0), seg(2.01), seg(1.99), seg(5.0)]], 0.03)
    expect(radii).toHaveLength(2)
    expect(radii[0]).toBeCloseTo(2, 2)
    expect(radii[1]).toBeCloseTo(5, 2)
    // 元の 3 本はすべて同じ値になる
    const rs = groups[0].map((g) => g.r)
    expect(new Set(rs).size).toBe(2)
  })

  it('離れた半径はまとめない', () => {
    const { radii } = harmonizeRadii([[seg(1), seg(2), seg(4)]], 0.03)
    expect(radii).toHaveLength(3)
  })

  it('直線は触らない', () => {
    const line: ContourSegment = { x: 1, y: 1, sweep: true }
    const { groups } = harmonizeRadii([[line, seg(2)]])
    expect(groups[0][0].r).toBeUndefined()
  })

  it('円弧が無ければ空', () => {
    expect(harmonizeRadii([[]]).radii).toEqual([])
  })
})
