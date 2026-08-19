import type { Contour } from './dsl'
import { getPaper, resetProject, type PaperCore } from './paper-setup'
import { radiusCandidates, snap } from './units'

/**
 * シルエットを円弧の列へ還元する。
 *
 * 円板を union して形を作る方式は、接合部に必ず凹んだ切れ込みが出るうえ、
 * 輪郭が「どの塊が重なったか」の副産物になり制御できなかった（実測: 手で
 * 最善を尽くしても鳥に見えなかった）。
 *
 * 幾何ロゴの輪郭は本来、複数の円弧が接点で切り替わりながら 1 周するもので、
 * 円は塗る対象ではなく「輪郭がどの弧を通るかを決める作図線」にすぎない。
 * ここでは既にある形（CC0 のシルエット等）からその円弧列を復元する。
 *
 * **本数を絞ることが成否を分ける。** 200 本当てればトレースされた絵にしか
 * ならない。8〜16 本に制限して初めてロゴとしての抽象になる。本数がそのまま
 * 抽象度の設計レバーになる。
 */

export type Vec = { x: number; y: number }
export type ContourSegment = Contour['segments'][number]

/** SVG の変換行列 [a b c d e f] */
type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/**
 * transform 属性を行列に直す。translate / scale / rotate / matrix に対応。
 *
 * 素材の SVG はトレース生成物が多く、`scale(0.1,-0.1)` のような上下反転を
 * 持つことがある。無視すると図形が逆さまになる（実測: PhyloPic の
 * シルエットが全て反転した）。
 */
export function parseTransform(value: string): Matrix {
  let m = IDENTITY
  for (const call of value.matchAll(/(translate|scale|rotate|matrix)\s*\(([^)]*)\)/g)) {
    const n = call[2]
      .split(/[\s,]+/)
      .map(Number)
      .filter((v) => Number.isFinite(v))
    switch (call[1]) {
      case 'translate':
        m = multiply(m, [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0])
        break
      case 'scale':
        m = multiply(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0])
        break
      case 'rotate': {
        const rad = ((n[0] ?? 0) * Math.PI) / 180
        const c = Math.cos(rad)
        const s = Math.sin(rad)
        m = multiply(m, [c, s, -s, c, 0, 0])
        break
      }
      case 'matrix':
        if (n.length >= 6) m = multiply(m, n.slice(0, 6) as Matrix)
        break
    }
  }
  return m
}

const num = (s: string | undefined) => {
  const v = Number.parseFloat(s ?? '')
  return Number.isFinite(v) ? v : 0
}

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))?.[1]

/** 点が閉曲線の内側か（レイキャスティング） */
function contains(polygon: Vec[], q: Vec): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/**
 * 各輪郭が他のいくつに包まれているかを数える。
 *
 * 合体済みの輪郭にだけ使うこと。合体前は兄弟どうしが重なるため、重なった
 * 領域が二重に数えられて実体と穴が入れ替わる。
 *
 * 用途は演算の順序決め。外側から順に足し引きしないと、穴を抜いた時点で
 * その中にある実体まで消える（実測: 蛇の目の中心の点が消えた）。
 */
export function nestingDepth(contours: Vec[][]): number[] {
  return contours.map((c, i) => {
    if (c.length === 0) return 0
    let depth = 0
    for (let j = 0; j < contours.length; j++) {
      if (i === j || contours[j].length < 3) continue
      if (contains(contours[j], c[0])) depth++
    }
    return depth
  })
}

/** 輪郭 1 本。solid が false なら内側の抜き。 */
export type TracedContour = { points: Vec[]; solid: boolean }

/** 図形の役割。ink は塗り足し、erase は塗り消し。 */
export type Paint = 'ink' | 'erase' | 'skip'

export type SvgShape = {
  d: string
  evenodd: boolean
  matrix: Matrix
  /** 塗りの役割。skip なら塗らない */
  paint: Paint
  /** 線の太さ（利用者座標系）。0 なら線なし */
  strokeWidth: number
  /** 線の役割 */
  strokePaint: Paint
  /** 線端を丸めるか（SVG の既定は butt なので false） */
  roundCap: boolean
  /** 切り抜きの型（clip-path）。無ければ null */
  clip: { d: string; matrix: Matrix } | null
}

const NAMED: Record<string, number> = {
  black: 0,
  white: 1,
  none: -1,
  transparent: -1,
}

/**
 * 塗り色の明るさから役割を決める。
 *
 * 素材は白地に黒とは限らない。実測では、黒い矩形の上に白いパスで紋を
 * 描いた反転素材があった（1 ファイルに白パス 179 本）。色を見ずに全部を
 * 合体させると、背景の矩形に飲まれて真っ黒になる。
 *
 * SVG の既定の塗りは黒なので、fill が無ければ ink とみなす。
 */
export function paintOf(tag: string, inheritedFill = ''): Paint {
  if (/display\s*:\s*none/.test(tag)) return 'skip'
  const opacity = attr(tag, 'fill-opacity') ?? attr(tag, 'opacity')
  if (opacity !== undefined && Number.parseFloat(opacity) === 0) return 'skip'

  const raw = (
    attr(tag, 'fill') ??
    tag.match(/[^-]fill\s*:\s*([^;"']+)/)?.[1] ??
    inheritedFill
  )
    .trim()
    .toLowerCase()
  if (raw === '') return 'ink' // SVG の既定は黒
  if (raw in NAMED) return NAMED[raw] < 0 ? 'skip' : NAMED[raw] < 0.5 ? 'ink' : 'erase'

  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    const r = Number.parseInt(full.slice(0, 2), 16)
    const g = Number.parseInt(full.slice(2, 4), 16)
    const b = Number.parseInt(full.slice(4, 6), 16)
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 ? 'ink' : 'erase'
  }

  const rgb = raw.match(/^rgba?\(([^)]+)\)/)?.[1]
  if (rgb) {
    const [r = 0, g = 0, b = 0] = rgb.split(/[\s,]+/).map(Number)
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 ? 'ink' : 'erase'
  }

  // url(#…) のグラデーションなど、判断できないものは塗りとして扱う
  return 'ink'
}

/** タグ 1 つを表す基本図形をパスデータへ直す。対象外なら null。 */
function tagToPathData(tag: string): string | null {
  if (tag.startsWith('<path')) return attr(tag, 'd') ?? null

  if (tag.startsWith('<circle') || tag.startsWith('<ellipse')) {
    const cx = num(attr(tag, 'cx'))
    const cy = num(attr(tag, 'cy'))
    const rx = num(attr(tag, 'rx')) || num(attr(tag, 'r'))
    const ry = num(attr(tag, 'ry')) || num(attr(tag, 'r'))
    if (rx <= 0 || ry <= 0) return null
    // 半円 2 本で 1 周する。1 本の弧では始点と終点が同じになり形が決まらない
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
  }

  if (tag.startsWith('<rect')) {
    const x = num(attr(tag, 'x'))
    const y = num(attr(tag, 'y'))
    const w = num(attr(tag, 'width'))
    const h = num(attr(tag, 'height'))
    if (w <= 0 || h <= 0) return null
    return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
  }

  const points = (attr(tag, 'points') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v))
  if (points.length < 6) return null
  const parts = [`M ${points[0]} ${points[1]}`]
  for (let i = 2; i + 1 < points.length; i += 2) parts.push(`L ${points[i]} ${points[i + 1]}`)
  return `${parts.join(' ')} Z`
}

/**
 * SVG から図形を、祖先の transform を解決した状態で取り出す。
 *
 * 「ファイル内の transform が 1 種類ならそれを全部に適用する」という手抜きは
 * PhyloPic のような単純な素材でしか通じない。Inkscape 製の家紋は要素ごとに
 * 別々の transform を持ち、無視すると図形が離れた場所へ散らばる（実測）。
 *
 * 完全な XML 解析はしない。タグの並びを見て `<g>` の開閉で行列のスタックを
 * 積み下ろしするだけで、素材として現れる構造は覆える。
 */
/**
 * clipPath の定義を集める。
 *
 * 中身は描画されないが、切り抜きの型として要る。無視すると切り抜かれる
 * はずの部分がはみ出し、空いているべき隙間が埋まる（実測: 丸に竪三つ引で
 * 縦棒が内側の円からはみ出した）。
 */
function collectClips(svgText: string): Map<string, { d: string; matrix: Matrix }> {
  const out = new Map<string, { d: string; matrix: Matrix }>()
  for (const m of svgText.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath>/g)) {
    const id = attr(`<x${m[1]}>`, 'id')
    if (!id) continue
    const own = attr(`<x${m[1]}>`, 'transform')
    const base = own ? parseTransform(own) : IDENTITY
    // 型は 1 つの図形に合成する
    const parts: string[] = []
    for (const [tag] of m[2].matchAll(/<(?:path|circle|ellipse|rect|polygon|polyline)\b[^>]*>/g)) {
      const d = tagToPathData(tag)
      if (d) parts.push(d)
    }
    if (parts.length > 0) out.set(id, { d: parts.join(' '), matrix: base })
  }
  return out
}

export function collectShapes(svgText: string): SvgShape[] {
  const out: SvgShape[] = []
  // 変換だけでなく塗りも継承する。<svg fill="none" stroke="#000"> のように
  // 親で塗りを消して線だけで描いた紋があり、要素の属性しか見ないと
  // 「塗り指定なし＝黒」と誤解して真っ黒な円板になる（実測）。
  const stack: Array<{ matrix: Matrix; fill: string; stroke: string; width: string }> = [
    { matrix: IDENTITY, fill: '', stroke: '', width: '' },
  ]

  const SHAPES = /^<(path|circle|ellipse|rect|polygon|polyline)\b/
  const clips = collectClips(svgText)

  // 描画されない要素の中身は落とす。clipPath の中の図形まで拾うと、
  // 切り抜きの型が実体として現れて紋が塗り潰される（実測）
  const body = svgText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(defs|clipPath|mask|marker|symbol|pattern)\b[\s\S]*?<\/\1>/g, '')

  for (const [tag] of body.matchAll(/<\/?[A-Za-z][^>]*>/g)) {
    const top = stack[stack.length - 1]

    if (tag.startsWith('</')) {
      if (/^<\/\s*(g|svg)\b/.test(tag) && stack.length > 1) stack.pop()
      continue
    }

    const own = attr(tag, 'transform')
    const matrix = own ? multiply(top.matrix, parseTransform(own)) : top.matrix
    const fill = attr(tag, 'fill') ?? tag.match(/[^-]fill\s*:\s*([^;"']+)/)?.[1] ?? top.fill
    const stroke = attr(tag, 'stroke') ?? tag.match(/[^-]stroke\s*:\s*([^;"']+)/)?.[1] ?? top.stroke
    const width =
      attr(tag, 'stroke-width') ?? tag.match(/stroke-width\s*:\s*([^;"']+)/)?.[1] ?? top.width
    const selfClosing = tag.endsWith('/>')

    if (/^<(g|svg)\b/.test(tag)) {
      if (!selfClosing) stack.push({ matrix, fill, stroke, width })
      continue
    }

    if (!SHAPES.test(tag)) continue
    const d = tagToPathData(tag)
    if (!d) continue

    const paint = paintOf(tag, top.fill)
    // 線でしか描かれていない紋がある。塗りが無いからと捨てると図形が消える
    const strokePaint = stroke.trim() === '' ? 'skip' : paintOf(`<x fill="${stroke}"/>`)
    const strokeWidth = strokePaint === 'skip' ? 0 : Math.max(num(width) || 1, 0)
    const cap = attr(tag, 'stroke-linecap') ?? tag.match(/stroke-linecap\s*:\s*([a-z]+)/)?.[1] ?? ''
    const clipId = (attr(tag, 'clip-path') ?? '').match(/url\(#([^)]+)\)/)?.[1]
    const clip = clipId ? clips.get(clipId) ?? null : null
    if (paint === 'skip' && strokeWidth <= 0) continue

    const rule = attr(tag, 'fill-rule') ?? tag.match(/fill-rule\s*:\s*([a-z]+)/)?.[1] ?? ''
    out.push({
      d,
      evenodd: rule.trim() === 'evenodd',
      matrix,
      paint,
      strokeWidth,
      strokePaint,
      roundCap: cap.trim() === 'round',
      clip: clip ? { d: clip.d, matrix: multiply(matrix, clip.matrix) } : null,
    })
  }

  return out
}

/**
 * 線を塗りの帯に変換する。
 *
 * paper-core にはパスのオフセットが無い。線に沿って半径 w/2 の円を並べて
 * 合体させると、丸い端と丸い継ぎ目を持つ帯になる。刷毛で撫でるのと同じ理屈で、
 * 実装が短く、自己交差する線でも破綻しない。
 *
 * 合体は左から順にではなく二分木で畳む。円が数百個になると、逐次の合体は
 * 結果が育つほど 1 回が重くなる。
 */
function strokeToFill(
  p: PaperCore,
  path: paper.PathItem,
  width: number,
  round: boolean,
): paper.PathItem | null {
  const r = width / 2
  if (r <= 0) return null

  const parts: paper.PathItem[] = []
  const walk = (child: paper.Path) => {
    const len = child.length
    if (len <= 0) return
    // 刻みは半径より細かく。粗いと帯の縁が波打つ
    const step = Math.max(r * 0.6, len / 400)

    // 継ぎ目を丸めるための円。端に置くかどうかは線端の指定で決まる。
    // SVG の既定は butt（端を伸ばさない）。既定のまま丸く置くと線が両端で
    // 半径ぶん伸び、空いているべき隙間が埋まる（実測: 丸に竪三つ引で
    // 縦棒が輪に接してしまった）。
    const from = child.closed || round ? 0 : Math.min(r, len / 2)
    const to = child.closed || round ? len : Math.max(len - r, len / 2)
    for (let d = from; d <= to + step; d += step) {
      const pt = child.getPointAt(Math.min(d, to))
      if (pt) parts.push(new p.Path.Circle(pt, r))
    }

    // butt の端は、進行方向に直交する矩形で塞ぐ
    if (!child.closed && !round) {
      for (const [at, sign] of [
        [from, -1],
        [to, 1],
      ] as const) {
        const pt = child.getPointAt(at)
        const tan = child.getTangentAt(at)
        if (!pt || !tan) continue
        const n = new p.Point(-tan.y, tan.x).multiply(r)
        const t = tan.multiply((r * sign) / 2)
        const mid = pt.add(t)
        const rect = new p.Path([
          mid.add(n).subtract(t),
          mid.add(n).add(t),
          mid.subtract(n).add(t),
          mid.subtract(n).subtract(t),
        ])
        rect.closed = true
        parts.push(rect)
      }
    }
  }
  const children = (path.children?.length ? path.children : [path]) as paper.Path[]
  for (const child of children) walk(child)
  if (parts.length === 0) return null

  let level = parts
  while (level.length > 1) {
    const next: paper.PathItem[] = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i])
        continue
      }
      const merged = level[i].unite(level[i + 1])
      level[i].remove()
      level[i + 1].remove()
      next.push(merged)
    }
    level = next
  }
  return level[0]
}

/**
 * SVG テキストから輪郭を取り出す。
 *
 * 実体と穴は面積の符号（＝向き）で判定する。面積の大きい順ではなく、
 * 実体を先に返す（最初の演算が抜きだと何も生まれない）。
 */
export function sampleContoursFromSvg(svgText: string, count = 720): TracedContour[] {
  const all = collectShapes(svgText)
  if (all.length === 0) return []

  const p = getPaper()
  resetProject()
  try {
    // 要素ごとに複合パスを作り、すべて合体させる。
    //
    // 全部の d を 1 つの複合パスにまとめて「最大が実体、残りは穴」とみなす
    // 単純化は、動物のシルエットでは通じるが家紋では破綻する。家紋は独立した
    // 図形が複数並び、しかも互いに重なる。包含関係を数えても、重なった領域が
    // 二重に数えられて実体と穴が入れ替わる（実測）。
    //
    // ブーリアンを paper に任せれば、結果の複合パスでは外周と穴が逆向きに
    // 揃う。向きで判定するのが最も確実。
    // 塗り順どおりに積み上げる。後に描かれたものが前を覆うという SVG の
    // 意味をそのまま辿れば、白地に黒でも黒地に白抜きでも同じ手順で扱える。
    let united = null as paper.PathItem | null

    /** 図形 1 つを、役割にしたがって積む */
    const apply = (item: paper.PathItem, paint: Paint) => {
      if (paint === 'skip') {
        item.remove()
        return
      }
      if (!united) {
        // まだ何も無いところから消しても何も起きない（先頭の白い背景など）
        if (paint === 'erase') {
          item.remove()
          return
        }
        united = item
        return
      }
      const next: paper.PathItem = paint === 'ink' ? united.unite(item) : united.subtract(item)
      united.remove()
      item.remove()
      united = next
    }

    for (const el of all) {
      const item = new p.CompoundPath(el.d)
      item.fillRule = el.evenodd ? 'evenodd' : 'nonzero'
      // 祖先から受け継いだ変換は、合体させる前に反映する。後で点へ掛けると
      // 図形どうしの位置関係が合わないまま union することになる
      if (el.matrix !== IDENTITY) item.transform(new p.Matrix(...el.matrix))

      // 切り抜きの型があれば、塗りにも線にも掛ける
      const clipWith = (target: paper.PathItem): paper.PathItem => {
        if (!el.clip) return target
        const shape = new p.CompoundPath(el.clip.d)
        if (el.clip.matrix !== IDENTITY) shape.transform(new p.Matrix(...el.clip.matrix))
        const cut = target.intersect(shape)
        target.remove()
        shape.remove()
        return cut
      }

      if (el.strokeWidth > 0) {
        // 線幅も変換の拡大率を受ける
        const scale = Math.sqrt(Math.abs(el.matrix[0] * el.matrix[3] - el.matrix[1] * el.matrix[2]))
        const band = strokeToFill(p, item, el.strokeWidth * (scale || 1), el.roundCap)
        if (band) apply(clipWith(band), el.strokePaint)
      }
      apply(clipWith(item.clone()), el.paint)
      item.remove()
    }
    if (!united) return []

    const children = (united.children?.length ? united.children : [united]) as paper.Path[]
    const measured = children
      .map((path) => ({
        path,
        area: (path as unknown as { area?: number }).area ?? 0,
      }))
      .filter((c) => c.path.length > 0 && c.area !== 0)
    if (measured.length === 0) return []

    // 最も面積の大きい輪郭は必ず実体。その向きを「実体の向き」とみなす
    const biggest = measured.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a))
    const solidSign = Math.sign(biggest.area)
    // 面積のしきい値は控えめに。0.4% では蛇の目の中心の点や細い縞が落ちて、
    // 紋が別物になった（実測）。素材のゴミを弾くだけの値にする
    const floor = Math.abs(biggest.area) * 0.0004
    const longest = biggest.path.length || 1

    const out: TracedContour[] = []
    for (const { path, area } of measured) {
      if (Math.abs(area) < floor) continue
      const n = Math.max(48, Math.round(count * Math.min(1, path.length / longest)))
      const points: Vec[] = []
      for (let i = 0; i < n; i++) {
        const pt = path.getPointAt((path.length * i) / n)
        if (pt) points.push({ x: pt.x, y: pt.y })
      }
      if (points.length >= 8) out.push({ points, solid: Math.sign(area) === solidSign })
    }

    // 実体を先に、面積の大きい順に。最初の演算が抜きだと何も生まれない
    return out.sort((a, b) => Number(b.solid) - Number(a.solid))
  } finally {
    resetProject()
  }
}

/** 円弧 1 本が張れる最大角。180 度を超えると始点と終点だけでは形が決まらない。 */
const MAX_SWEEP = (170 * Math.PI) / 180

/**
 * SVG のパスデータを等間隔にサンプリングして閉曲線の集合にする。
 *
 * 面積の大きい順に返す。先頭が外形で、以降は内側の抜き（目・口・模様）。
 * 抜きを捨てると単なる塊になり、ロゴとして成立しない。負の空間こそが
 * 幾何ロゴの効きどころなので、外形と一緒に拾う。
 *
 * ごく小さいものは素材のゴミ（アンチエイリアスの残骸、点）なので落とす。
 */
export function sampleContours(pathData: string, count = 720): Vec[][] {
  const p = getPaper()
  resetProject()
  try {
    const item = new p.CompoundPath(pathData)
    const children = item.children.length > 0 ? item.children : [item]

    const found: Array<{ area: number; points: Vec[] }> = []
    for (const child of children) {
      const path = child as paper.Path
      const area = Math.abs((path as unknown as { area?: number }).area ?? 0)
      if (path.length === 0 || area <= 0) continue

      // 小さい輪郭は点も減らす。720 点も要らないうえ、当てる円弧が増えすぎる
      const longest = (children[0] as paper.Path).length || path.length
      const n = Math.max(48, Math.round(count * Math.min(1, path.length / longest)))
      const points: Vec[] = []
      for (let i = 0; i < n; i++) {
        const pt = path.getPointAt((path.length * i) / n)
        if (pt) points.push({ x: pt.x, y: pt.y })
      }
      if (points.length >= 8) found.push({ area, points })
    }

    found.sort((a, b) => b.area - a.area)
    if (found.length === 0) return []

    const floor = found[0].area * 0.004
    return found.filter((f) => f.area >= floor).map((f) => f.points)
  } finally {
    resetProject()
  }
}

/**
 * 点列に円を最小二乗で当てる（Kåsa 法）。
 *
 * 直線に近い並びでは半径が発散するので、その場合は null を返して直線として扱う。
 */
function fitCircle(points: Vec[]): { cx: number; cy: number; r: number } | null {
  const n = points.length
  if (n < 3) return null

  let mx = 0
  let my = 0
  for (const q of points) {
    mx += q.x
    my += q.y
  }
  mx /= n
  my /= n

  let suu = 0
  let suv = 0
  let svv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (const q of points) {
    const u = q.x - mx
    const v = q.y - my
    suu += u * u
    suv += u * v
    svv += v * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }

  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-12) return null

  const c1 = (suuu + suvv) / 2
  const c2 = (svvv + svuu) / 2
  const uc = (c1 * svv - c2 * suv) / det
  const vc = (c2 * suu - c1 * suv) / det
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  if (!Number.isFinite(r) || r <= 0) return null

  return { cx: uc + mx, cy: vc + my, r }
}

/** 当てた円と点列の最大ずれ */
function maxDeviation(points: Vec[], c: { cx: number; cy: number; r: number }): number {
  let worst = 0
  for (const q of points) {
    const d = Math.abs(Math.hypot(q.x - c.cx, q.y - c.cy) - c.r)
    if (d > worst) worst = d
  }
  return worst
}

/** 両端を結ぶ弦から、点列が最も離れる距離 */
function maxDeviationFromChord(points: Vec[]): number {
  const a = points[0]
  const b = points[points.length - 1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  // 始点と終点が重なるなら「直線」ではない。伸ばさせない
  if (len < 1e-9) return Number.POSITIVE_INFINITY

  let worst = 0
  for (const q of points) {
    const d = Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / len
    if (d > worst) worst = d
  }
  return worst
}

/** 中心から見た角度差（符号つき、-π〜π） */
function angleDelta(from: number, to: number): number {
  let d = to - from
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

/**
 * 貪欲に円弧を当てていく。
 *
 * 始点から窓を伸ばし、ずれが許容量を超えるか 170 度を超えたところで 1 本
 * 確定して次へ進む。許容量を上げるほど本数が減るので、目標本数に収まるまで
 * 許容量を二分探索する。「何本で描くか」を先に決める作り。
 */
function fitPass(points: Vec[], tol: number, scale: number): ContourSegment[] {
  const n = points.length
  // 半径がこれを超えたら直線として扱う。家紋や紋章には直線の辺が多く、
  // 巨大な半径の円弧で近似すると、わずかに膨らんで菱形が団子になる（実測）。
  const straight = scale * 12
  const segments: ContourSegment[] = []
  let start = 0
  let guard = 0
  /** 前の弧が実際に終わった点。円上へ載せた座標を引き継ぐ */
  let cursor: Vec | null = null

  while (start < n && guard++ < n * 2) {
    let end = Math.min(start + 3, n)
    let accepted: { end: number; c: ReturnType<typeof fitCircle> } | null = null

    while (end <= n) {
      const window = points.slice(start, end + 1)
      // 円弧と直線の両方を当てて、誤差の小さいほうを採る。
      //
      // 半径や行列式の大きさで直線かどうかを判定してはいけない。丸め誤差で
      // わずかに非直線になった点列に対し、最小二乗が極小半径のでたらめな円を
      // 返すことがあり、そのずれで窓が伸びず菱形が団子になった（実測）。
      // 誤差そのものを比べれば、退化した当てはめは自然に負ける。
      const fitted = fitCircle(window)
      const devLine = maxDeviationFromChord(window)
      const devArc =
        fitted && fitted.r <= straight ? maxDeviation(window, fitted) : Number.POSITIVE_INFINITY

      // 円弧を採るのは、直線より明らかに良いときだけ。同程度なら直線を選ぶ。
      // 紋や記号の直線の辺が、わずかに膨らんだ円弧になるのを防ぐ。
      //
      // ただし「同程度なら直線」を無条件に適用すると、**緩い曲線まで弦に
      // 落ちる**。有機的な輪郭では、それが多角形に見える原因になる（実測:
      // ゴリラの外周は 90 本中 36 本が直線で、継ぎ目に角が並んだ）。
      // 弦からの外れが目に見える大きさを超えていれば、そこは実際に曲がって
      // いるので、2 倍の条件を満たさなくても弧を採る。
      //
      // この境目は**画素の階段より上**に置くこと。画素から起こした輪郭は、
      // 幾何学的に完全な直線の辺でもマークの 1% ほど弦から外れる（実測: 512px
      // の星で 5 画素）。しかも階段は輪郭追跡の都合で片側に揃うので、僅かに
      // 反れた円のほうが誤差が小さくなる。0.4% に置いたときは、星の辺 10 本の
      // うち 8 本が半径 7〜11（マーク幅の 2 倍超）の弧に化けて辺が撓んだ。
      const flat = scale * 0.012
      const c = devArc * 2 < devLine || (devLine > flat && devArc <= devLine) ? fitted : null
      if (Math.min(devArc, devLine) > tol) break

      if (c) {
        const a0 = Math.atan2(window[0].y - c.cy, window[0].x - c.cx)
        const a1 = Math.atan2(
          window[window.length - 1].y - c.cy,
          window[window.length - 1].x - c.cx,
        )
        if (Math.abs(angleDelta(a0, a1)) > MAX_SWEEP) break
      }
      accepted = { end, c }
      end++
    }

    const stop = accepted?.end ?? Math.min(start + 3, n)
    // 始点は「実際に前の弧が終わった点」。入力配列は書き換えないこと。
    // 二分探索は同じ配列で何度も試すので、書き換えると回を追うごとに
    // 形が劣化する（実測: 完全な菱形が 4 本ではなく 12 本になった）。
    const from = cursor ?? points[start]
    const to = points[Math.min(stop, n - 1)]
    const c = accepted?.c ?? null

    if (c) {
      // 膨らむ向きは、当てた円の中心から見た角度が増える向きかどうかで決まる。
      // 弦と中点の位置関係から推定すると符号を取り違えやすく、実際に輪郭が
      // 内側へ膨らんで棘だらけの星形になった。中心があるなら中心から測る。
      const a0 = Math.atan2(from.y - c.cy, from.x - c.cx)
      const a1 = Math.atan2(to.y - c.cy, to.x - c.cx)

      // 終点を当てはめた円の上へ載せる。
      //
      // SVG の弧は端点と半径から中心を逆算するので、端点が円から外れていると
      // 復元される円は当てはめたものと別になり、浅い弧ほど大きくずれる。
      // 当てはめでは許容内なのに描くと合わない、という食い違いの原因
      // （実測: 4 本で内部判定は通るのに、完成形の一致率は 96%）。
      const projected = {
        x: c.cx + Math.cos(a1) * c.r,
        y: c.cy + Math.sin(a1) * c.r,
      }
      cursor = projected

      // SVG は y 下向きなので、角度が増える向き＝見た目の時計回り＝sweep 1
      segments.push({
        x: round(projected.x),
        y: round(projected.y),
        r: round(c.r),
        sweep: angleDelta(a0, a1) > 0,
      })
    } else {
      cursor = to
      segments.push({ x: round(to.x), y: round(to.y), sweep: true })
    }

    if (stop >= n - 1) break
    start = stop
  }
  return segments
}

const round = (v: number) => Math.round(v * 1000) / 1000

/**
 * マーク全体で使われている半径を、少数の代表値へ揃える。
 *
 * 「円弧が体系に載っていない」という批評への答え。外部の比例体系（黄金比の
 * 階梯など）へ寄せると形が壊れるが、それは体系が形より後に来ているから。
 * マーク自身が実際に使っている半径を数え上げて代表値へ寄せれば、体系は
 * 外から押しつけるものではなく取り出すものになる。
 *
 * 家紋のような作図された図形は、もともと少数の半径しか使っていない。
 * 当てはめの誤差でばらついた値を畳み直すだけなので、形もほとんど動かない。
 */
export function harmonizeRadii(
  groups: ContourSegment[][],
  tolerance = 0.03,
): { groups: ContourSegment[][]; radii: number[] } {
  const values = groups
    .flat()
    .map((g) => g.r)
    .filter((r): r is number => r !== undefined && r > 0)
    .sort((a, b) => a - b)
  if (values.length === 0) return { groups, radii: [] }

  // 近い値をまとめて代表値（平均）を作る
  const clusters: number[][] = [[values[0]]]
  for (const v of values.slice(1)) {
    const current = clusters[clusters.length - 1]
    const mean = current.reduce((a, b) => a + b, 0) / current.length
    if (Math.abs(v - mean) / mean <= tolerance) current.push(v)
    else clusters.push([v])
  }
  const radii = clusters.map((c) => round(c.reduce((a, b) => a + b, 0) / c.length))

  const nearest = (r: number) =>
    radii.reduce((best, cand) => (Math.abs(cand - r) < Math.abs(best - r) ? cand : best), radii[0])

  return {
    groups: groups.map((segs) =>
      segs.map((g) => (g.r === undefined ? g : { ...g, r: nearest(g.r) })),
    ),
    radii,
  }
}

/** 弧の中心・半径・両端の接線 */
type ArcGeometry = { cx: number; cy: number; r: number; t0: number; t1: number }

/** セグメント（前の点 → この点）の幾何を求める */
function arcGeometry(from: Vec, seg: ContourSegment): ArcGeometry | null {
  if (seg.r === undefined) return null
  const dx = seg.x - from.x
  const dy = seg.y - from.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return null

  const r = Math.max(seg.r, d / 2)
  const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0))
  const sign = seg.sweep ? 1 : -1
  const cx = (from.x + seg.x) / 2 + sign * h * (-dy / d)
  const cy = (from.y + seg.y) / 2 + sign * h * (dx / d)
  // 接線は半径に直交し、回る向きで符号が決まる
  const tangent = (px: number, py: number) =>
    Math.atan2(sign * (px - cx), -sign * (py - cy))
  return { cx, cy, r, t0: tangent(from.x, from.y), t1: tangent(seg.x, seg.y) }
}

/** 点 P で向き t に接し、点 Q を通る円。戻りは半径と回る向き。 */
function arcThrough(p: Vec, t: number, q: Vec): { r: number; sweep: boolean } | null {
  // 中心は接線の法線上にある。C = P + r*N
  const nx = -Math.sin(t)
  const ny = Math.cos(t)
  const vx = q.x - p.x
  const vy = q.y - p.y
  const denom = 2 * (nx * vx + ny * vy)
  if (Math.abs(denom) < 1e-9) return null // 直線に近い
  const r = (vx * vx + vy * vy) / denom
  if (!Number.isFinite(r) || Math.abs(r) < 1e-9) return null

  // 回る向きは、接線から終点へどちらへ曲がるかで決まる
  const cross = Math.cos(t) * vy - Math.sin(t) * vx
  return { r: Math.abs(r), sweep: cross > 0 }
}

/**
 * 継ぎ目の接線を揃える（G1 連続にする）。
 *
 * 円弧を独立に当てはめると、継ぎ目で接線が折れる。実測では平均 44.8°、
 * 継ぎ目の 95% が 5° 以上折れていた。小さく見ると滑らかでも、幾何としては
 * 角が並んでいる。人の作図はここを揃えるので輪郭が流れて見える。
 *
 * 各アンカーの接線を前後の平均として決め、隣り合うアンカーの間を biarc
 * （接線連続な 2 本組の円弧）で結び直す。本数は倍になるが、半径は
 * harmonizeRadii でまとめ直せる。
 */
export function smoothJoints(segments: ContourSegment[], cornerDegrees = 55): ContourSegment[] {
  const n = segments.length
  if (n < 3) return segments

  // 接線がほぼ平行な継ぎ目では biarc の半径が発散する。**当てはめ側（fitPass）は
  // 同じ基準で直線へ落としているのに、ここだけ素通しだった。** DSL の寸法上限
  // （500）を超えると designSchema が拒み、その弧 1 本ではなく**設計ごと**
  // コンパイルに失敗する（実測: 熊の顔の頬で r が 500 を超え、マークが消えた）。
  // ほぼ平行なら実際に直線なので、直線として出す。
  const xs = segments.map((s) => s.x)
  const ys = segments.map((s) => s.y)
  const straight =
    Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.05) * 12
  /** 半径が大きすぎる弧は直線として置く */
  const arc = (to: ContourSegment, at: Vec, r: number, sweep: boolean): ContourSegment =>
    r <= straight
      ? { ...to, x: round(at.x), y: round(at.y), r: round(r), sweep }
      : { ...to, x: round(at.x), y: round(at.y), r: undefined }

  // 各アンカーでの接線。前の弧の出口と次の弧の入口を平均する。
  //
  // ただし全アンカーを平均すると、角が 1 つ残らず丸まる。嘴・棘・鰭・尾の
  // 切れ込みは、輪郭がそこで折れることそのものが形の手がかりなので、
  // 消すと題材が読めない塊になる（実測: 魚の尾が団子になった）。
  // 大きく折れているアンカーは意図された角と見なし、平均しない。
  const enter: number[] = []
  const exit: number[] = []
  const limit = (cornerDegrees * Math.PI) / 180
  for (let i = 0; i < n; i++) {
    const prev = segments[(i - 1 + n) % n]
    const cur = segments[i]
    const next = segments[(i + 1) % n]
    const a = arcGeometry(prev, cur)
    const b = arcGeometry(cur, next)
    const inDir = a ? a.t1 : Math.atan2(cur.y - prev.y, cur.x - prev.x)
    const outDir = b ? b.t0 : Math.atan2(next.y - cur.y, next.x - cur.x)
    // 折れ角。-π〜π に畳んでから見る
    const turn = Math.abs(Math.atan2(Math.sin(outDir - inDir), Math.cos(outDir - inDir)))
    // 両側が直線の継ぎ目は、折れが浅くても**頂点**である。そこには曲率が無いのに
    // 平均を取ると、直線の辺そのものが弧に変えられてしまう（実測: 五角形の肩は
    // 35° の折れで閾値 55° を下回り、縦の辺が膨らんで釣鐘型になった）。
    // ごく浅い折れだけは、曲線を折れ線で近似した名残とみなして均す
    const vertex =
      prev.r === undefined && cur.r === undefined && turn > (8 * Math.PI) / 180
    if (turn > limit || vertex) {
      enter.push(inDir)
      exit.push(outDir)
      continue
    }
    const mean = Math.atan2(
      Math.sin(inDir) + Math.sin(outDir),
      Math.cos(inDir) + Math.cos(outDir),
    )
    enter.push(mean)
    exit.push(mean)
  }

  const out: ContourSegment[] = []
  for (let i = 0; i < n; i++) {
    const from = segments[i]
    const to = segments[(i + 1) % n]
    const t0 = exit[i]
    const t1 = enter[(i + 1) % n]

    const vx = to.x - from.x
    const vy = to.y - from.y
    const c0 = Math.cos(t0)
    const s0 = Math.sin(t0)
    const c1 = Math.cos(t1)
    const s1 = Math.sin(t1)
    const dot = c0 * c1 + s0 * s1
    const vt = vx * (c0 + c1) + vy * (s0 + s1)
    const vv = vx * vx + vy * vy
    const den = 2 * (1 - dot)

    let joint: Vec | null = null
    if (den > 1e-6) {
      const disc = vt * vt + den * vv
      if (disc >= 0) {
        const d = (-vt + Math.sqrt(disc)) / den
        if (Number.isFinite(d) && d > 1e-6) {
          joint = {
            x: (from.x + d * c0 + (to.x - d * c1)) / 2,
            y: (from.y + d * s0 + (to.y - d * s1)) / 2,
          }
        }
      }
    } else {
      // 両端の接線が平行な区間。
      //
      // 弦も同じ向きなら、そこは本当に直線なので 1 本で足りる（角と角を結ぶ
      // 辺がこれ。2 本に割っても同じ形にしかならない）。
      //
      // 弦が傾いているときは 1 本の弧に落としてはいけない。円弧の接線は回った
      // 角だけ回るので、始点で t0 に合わせた弧の終点は必ず t0 から傾いており、
      // **終点側が合わない**。継ぎ目にそのぶんの折れが残る（実測: 目のような
      // 小さな輪郭で平均 13.8°）。逆向きに膨らむ 2 本＝S 字の biarc なら、
      // 弦の中点で継いで両端の接線に合う。
      const chord = Math.atan2(vy, vx)
      const off = Math.abs(Math.atan2(Math.sin(chord - t0), Math.cos(chord - t0)))
      if (off > 1e-3 && Math.PI - off > 1e-3) {
        joint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
      }
    }

    if (!joint) {
      const one = arcThrough(from, t0, to)
      out.push(one ? arc(to, to, one.r, one.sweep) : { ...to, r: undefined })
      continue
    }

    const a1 = arcThrough(from, t0, joint)
    // 2 本目は終点側から逆向きに引くと、終点の接線に確実に合う
    const a2 = arcThrough(to, t1 + Math.PI, joint)
    out.push(
      a1
        ? arc({ x: joint.x, y: joint.y, sweep: a1.sweep }, joint, a1.r, a1.sweep)
        : { x: round(joint.x), y: round(joint.y), sweep: true },
    )
    out.push(a2 ? arc(to, to, a2.r, !a2.sweep) : { ...to, r: undefined })
  }
  return out
}

/**
 * マイターの上限（距離の何倍まで角を尖らせるか）。
 *
 * 角では 2 本の弧の外側が交わる点まで伸ばすのが厳密な等距離だが、鋭い角ほど
 * 交点が遠くへ飛ぶ（嘴や尾の切れ込みは 20° を切る）。伸ばしきると弦が長く
 * なりすぎて、当てはめた弧が半円へ丸められる。実用上はここで頭を落とす。
 */
const MITER_LIMIT = 2.5

/**
 * 閉じた輪郭を外側へ一定幅ふくらませる。
 *
 * 白の縁取り（キーライン）は「太らせた同じ形を先に抜いてから本体を置く」ことで
 * 作る。抜く形が本体と**どこでも同じだけ離れている**必要があるので、点列を
 * 太らせて当てはめ直すのではなく、**当てはめ済みの弧をそのまま等距離に移す**。
 *
 *  - アンカーは外向き法線へ動かす。角では前後の法線の二等分線へ、マイター長ぶん
 *  - 弧の半径は、外へ膨らんでいれば +d、内へ凹んでいれば −d
 *
 * 本数も継ぎ目の対応も変わらないので、幅は構成上どこでも d になる。凹みが d より
 * きつい所では外側の形が自分と交わるが、ブーリアンの側が解いてくれる。
 */
export function offsetContour(segments: ContourSegment[], distance: number): ContourSegment[] {
  const n = segments.length
  if (n < 3 || !(distance > 0)) return segments

  // 内と外を決める。符号付き面積の向きがそのまま法線の向きになる
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = segments[i]
    const b = segments[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  const orient = area >= 0 ? 1 : -1
  /** 進行方向 t に対する外向きの単位法線 */
  const outwardOf = (t: number): Vec => ({
    x: orient * Math.sin(t),
    y: -orient * Math.cos(t),
  })

  // 各アンカーの、入る側と出る側の外向き法線。smoothJoints と同じ読み方
  const nIn: Vec[] = []
  const nOut: Vec[] = []
  for (let i = 0; i < n; i++) {
    const prev = segments[(i - 1 + n) % n]
    const cur = segments[i]
    const next = segments[(i + 1) % n]
    const a = arcGeometry(prev, cur)
    const b = arcGeometry(cur, next)
    nIn.push(outwardOf(a ? a.t1 : Math.atan2(cur.y - prev.y, cur.x - prev.x)))
    nOut.push(outwardOf(b ? b.t0 : Math.atan2(next.y - cur.y, next.x - cur.x)))
  }

  const moved: Vec[] = segments.map((s, i) => {
    let mx = nIn[i].x + nOut[i].x
    let my = nIn[i].y + nOut[i].y
    const len = Math.hypot(mx, my)
    // 折り返し（180°）では二等分線が消える。入る側の法線で逃がす
    if (len < 1e-9) return { x: s.x + nIn[i].x * distance, y: s.y + nIn[i].y * distance }
    mx /= len
    my /= len
    const cos = mx * nIn[i].x + my * nIn[i].y
    const reach = distance / Math.max(cos, 1 / MITER_LIMIT)
    return { x: s.x + mx * reach, y: s.y + my * reach }
  })

  return segments.map((cur, i) => {
    const at = moved[i]
    const g = cur.r === undefined ? null : arcGeometry(segments[(i - 1 + n) % n], cur)
    if (!g) return { ...cur, x: round(at.x), y: round(at.y) }
    // 中心が内側にあれば外へ膨らんでいる。そちらは半径が増える
    const nEnd = outwardOf(g.t1)
    const convex = nEnd.x * (cur.x - g.cx) + nEnd.y * (cur.y - g.cy) > 0
    const r = convex ? g.r + distance : g.r - distance
    return {
      x: round(at.x),
      y: round(at.y),
      // 凹みが縁取りよりきつい弧は、動かした端点どうしを直線で結ぶ
      r: r > 1e-3 ? round(r) : undefined,
      sweep: cur.sweep,
    }
  })
}

export type TraceOptions = {
  /**
   * 許容誤差を輪郭の大きさに対する比で与える。
   *
   * 本数を指定するより素直で、結果として本数が最小になる。本数指定だと、
   * 二分探索が上限いっぱいまで細かく刻もうとして冗長な弧が並ぶ。しかも
   * 冗長なだけでなく精度も落ちる（実測: 二つ巴で 16 本 99.94%、28 本 99.55%）。
   * 端点指定の円弧は 1 本ごとに丸め誤差を抱えるため、刻むほど誤差が積もる。
   */
  toleranceRatio?: number
  /** 目標の円弧本数。toleranceRatio があればそちらが優先される */
  maxArcs?: number
  /**
   * 左右対称なら片側だけ当てはめて反転する。既定は有効（輪郭ごとに判定）。
   * 'force' で判定を飛ばし、mirrorX の軸で必ず対称に作る。
   * 軸はマーク全体で 1 つに決めて mirrorX で渡すこと。
   */
  symmetry?: boolean | 'force'
  /** マーク全体の対称軸（x 座標） */
  mirrorX?: number
  /**
   * 半径を比例体系の候補へ寄せるか。既定は寄せない。
   *
   * 生成した設計では「作図した感」を出す有効な処理だが、トレースでは
   * 元の形が設計そのものなので、寄せると形が壊れる。
   * 実測（二つ巴・円弧 8 本）: 寄せると 96.10%、寄せないと 99.87%。
   */
  snapRadii?: boolean
}

export type TraceResult = {
  segments: ContourSegment[]
  /** 実際に使われた許容誤差（モジュール単位） */
  tolerance: number
}

/**
 * 閉曲線を、指定本数以内の円弧列へ還元する。
 *
 * 点列はモジュール単位に正規化済みであることを前提にする（呼び出し側で
 * fitToModule を通す）。許容誤差もモジュール単位。
 */
/**
 * 対称性を保ったまま当てはめる。
 *
 * 片側だけに円弧を当て、残りは反転して作る。アンカーの位置も半径も厳密に
 * 鏡像になり、モデルの当てはめ結果が左右で食い違うことがなくなる。
 * 対称なモチーフでは、これが「作図した」形と「当てはめた」形の差になる。
 */
/**
 * 軸上で始まり軸上で終わる片側の区間を当てはめ、鏡像で戻して閉じる。
 *
 * 各セグメントは「1 つ前の点から、この点まで」を表す。
 * 片側が  始点 → p1 → … → 終点（軸上）  なら、戻りは
 *         終点 → mirror(p_{k-1}) → … → mirror(p1) → 始点
 * となり、i 番目の戻り弧は k-i 番目の往き弧の鏡像になる。
 */
function mirrorClosedRun(
  half: Vec[],
  axis: number,
  options: TraceOptions,
): { outward: ContourSegment[]; back: ContourSegment[]; tolerance: number } | null {
  if (half.length < 8) return null
  // 端を軸の上へ載せる。ここがずれると継ぎ目が開く
  const onAxis = (q: Vec): Vec => ({ x: axis, y: q.y })
  const chain = [onAxis(half[0]), ...half.slice(1, -1), onAxis(half[half.length - 1])]

  const fitted = traceArcs(chain, { ...options, symmetry: false })
  if (fitted.segments.length < 2) return null

  const outward = fitted.segments
  const k = outward.length
  const start = chain[0]
  const back: ContourSegment[] = []
  for (let j = 0; j < k; j++) {
    const source = outward[k - 1 - j] // 鏡像のもとになる往きの弧
    const target = k - 2 - j // その 1 つ手前の点へ戻る
    const end = target >= 0 ? outward[target] : start
    back.push({
      x: round(2 * axis - end.x),
      y: round(end.y),
      r: source.r,
      // 向きは変えない。鏡像で 1 度反転し、逆順に辿ることでもう 1 度反転するので、
      // 2 つが打ち消し合って元の向きに戻る
      sweep: source.sweep,
    })
  }
  return { outward, back, tolerance: fitted.tolerance }
}

function traceMirrored(points: Vec[], axis: number, options: TraceOptions): TraceResult | null {
  const crossings = axisCrossings(points, axis)
  // 対称で穴の無い領域の外周は、軸をちょうど 2 回しか横切れない（2k 回横切る
  // 閉曲線が対称なら、k 番目の右区間の鏡像は直後の左区間でなければならず、
  // その終点が k 番目の始点に戻る＝2 回、と示せる）。4 回以上は**位相が非対称**
  // ——片側だけ 1〜2 画素の橋で繋がっている——ので、輪郭単位では直せない。
  // 復元側は輪郭を取り出す前にマスクを画素で対称化して、ここへ来る輪郭が必ず
  // 2 回になるようにしている（reconstruct.ts の symmetrizeMask）
  if (crossings.length !== 2) return null

  const [a, b] = crossings
  const half = points.slice(a + 1, b + 1)
  const run = mirrorClosedRun(half, axis, options)
  if (!run) return null
  return { segments: [...run.outward, ...run.back], tolerance: run.tolerance }
}

export function traceArcs(points: Vec[], options: TraceOptions = {}): TraceResult {
  const maxArcs = Math.max(3, Math.min(options.maxArcs ?? 12, 64))
  if (points.length < 8) return { segments: [], tolerance: 0 }

  // 対称なら片側だけ当てはめて反転する。
  //
  // 既定では輪郭ごとに対称かを判定するが、呼ぶ側が「マーク全体が対称」と決めて
  // いるときは判定を飛ばして**強制**できる（symmetry: 'force'）。生成画像の
  // 個々の輪郭は素でわずかに歪んでいて、判定（一致 97%）を落とすことがある。
  // 判定に任せると、外周だけ対称で顔の白は非対称、という中途半端が出る
  // （実測: 正面のゴリラ 3 枚で、輪郭 8 本のうち対称に作られたのは 2〜4 本）
  if (options.symmetry !== false) {
    const axis =
      options.symmetry === 'force' && options.mirrorX !== undefined
        ? options.mirrorX
        : mirrorAxis(points, options.mirrorX)
    if (axis !== null) {
      const mirrored = traceMirrored(points, axis, options)
      if (mirrored) return mirrored
    }
  }

  // 直線判定の基準になる輪郭の大きさ
  const xs = points.map((q) => q.x)
  const ys = points.map((q) => q.y)
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.05)

  // 精度を指定されたら一発で決める。探索は要らず、本数は自然に最小になる
  if (options.toleranceRatio !== undefined) {
    const tol = scale * options.toleranceRatio
    const segments = straightenRuns(fitPass(points, tol, scale), scale)
    return {
      segments: options.snapRadii ? segments.map((g) => (g.r === undefined ? g : snapRadius(g))) : segments,
      tolerance: round(tol),
    }
  }

  // 許容誤差を二分探索する。大きくすると本数が減る単調な関係なので収束する。
  let lo = 0.002
  let hi = 1.5
  let best = fitPass(points, hi, scale)

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const segments = fitPass(points, mid, scale)
    if (segments.length > maxArcs) {
      lo = mid
    } else {
      best = segments
      hi = mid
    }
  }

  const tidied = straightenRuns(best, scale)
  const segments = options.snapRadii
    ? tidied.map((s) => (s.r === undefined ? s : snapRadius(s)))
    : tidied

  return { segments, tolerance: round(hi) }
}

/**
 * ほぼ一直線に並んだ連なりを、1 本の直線へまとめる。
 *
 * 当てはめは窓ごとに判断するので、1 本の直線の辺が「わずかに曲がった弧＋直線」
 * のように割れて残ることがある。元の画素は簡略化（許容 2 画素）を通っており、
 * 直線の辺にも 1〜2 画素のジグザグが残っているためで、当てはめはそれを忠実に
 * なぞってしまう（実測: 生成した星の辺 12 本のうち 4 本が半径 5 前後＝マーク幅
 * を超える「ほぼ直線の弧」になり、腕が波打って見えた）。
 *
 * 人が清書するときは、そこを 1 本の直線に引き直す。連なりの両端を結ぶ弦から
 * 途中の点も弧の膨らみも外れていなければ、それは直線として描くべきもの。
 *
 * 角（大きく折れる点）は必ず残す。ここを跨いでまとめると形が崩れる。
 */
function straightenRuns(segments: ContourSegment[], scale: number): ContourSegment[] {
  const n = segments.length
  if (n < 3) return segments
  const limit = scale * 0.02

  /** i 番の弧の膨らみ（直線なら 0） */
  const sagOf = (i: number): number => {
    const seg = segments[i]
    if (seg.r === undefined) return 0
    const from = segments[(i - 1 + n) % n]
    const ch = Math.hypot(seg.x - from.x, seg.y - from.y)
    const r = Math.max(seg.r, ch / 2)
    return r - Math.sqrt(Math.max(r * r - (ch / 2) ** 2, 0))
  }

  const out: ContourSegment[] = []
  let i = 0
  while (i < n) {
    // i 番から始めて、まとめられるところまで伸ばす
    let end = i
    while (end + 1 < n) {
      const startPt = segments[(i - 1 + n) % n]
      const cand = segments[end + 1]
      const dx = cand.x - startPt.x
      const dy = cand.y - startPt.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-9) break
      // 途中の点と弧の膨らみが、両端を結ぶ弦から離れていないこと
      let worst = 0
      for (let k = i; k <= end + 1; k++) {
        const p = segments[k]
        worst = Math.max(worst, Math.abs((p.x - startPt.x) * dy - (p.y - startPt.y) * dx) / len)
        worst = Math.max(worst, sagOf(k))
      }
      if (worst > limit) break
      end++
    }
    if (end > i) {
      // まとめた区間は 1 本の直線にする
      out.push({ ...segments[end], r: undefined, sweep: true })
      i = end + 1
    } else {
      out.push(segments[i])
      i++
    }
  }
  return out
}

/**
 * 半径を比例体系の候補へ寄せる。
 *
 * ここが「作図した感」の出どころ。実測値のままだと 1.87 のような濁った寸法が
 * 並び、設計図が図面に見えない。ただし寄せすぎると輪郭が崩れるので、
 * 半径の 12% 以内に候補があるときだけ採用する。
 */
function snapRadius(seg: ContourSegment): ContourSegment {
  if (seg.r === undefined) return seg
  const hit = snap(seg.r, radiusCandidates(), 0.12)
  return hit ? { ...seg, r: round(hit.value) } : seg
}

/**
 * 左右対称の軸を探す。対称でなければ null。
 *
 * 対称なモチーフを左右で独立に当てはめると、アンカーの位置も半径も食い違う。
 * 形としてはほぼ同じに見えるが、作図としては別物になる。デザイナーは対称の
 * モチーフをまず対称性ごと決めてから引く。
 */
export function mirrorAxis(points: Vec[], candidate?: number, tolerance = 0.02): number | null {
  if (points.length < 12) return null
  const xs = points.map((q) => q.x)
  const ys = points.map((q) => q.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const span = Math.max(maxX - minX, Math.max(...ys) - Math.min(...ys))
  if (span <= 0) return null

  // 軸はマーク全体で 1 つ。輪郭ごとの中心を軸にしてはいけない。
  // 十字の 4 つの抜きのように、個々は非対称でも対で対称という要素があり、
  // 自分の中心を軸とみなして反転すると別の形になる（実測: 一致率 96%→79%）。
  const cell = span * tolerance
  const key = (q: Vec) => `${Math.round(q.x / cell)}:${Math.round(q.y / cell)}`
  const grid = new Set(points.map(key))

  const scoreAt = (axis: number): number => {
    let hit = 0
    for (const q of points) {
      const m = { x: 2 * axis - q.x, y: q.y }
      // 折り返した点が、その周囲 1 マス以内に見つかれば一致とみなす
      let found = false
      for (let dx = -1; dx <= 1 && !found; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (grid.has(`${Math.round(m.x / cell) + dx}:${Math.round(m.y / cell) + dy}`)) {
            found = true
            break
          }
        }
      }
      if (found) hit++
    }
    return hit / points.length
  }

  // 軸を外接矩形の中央に決め打ちしない。片側の毛先が少し出ているだけで軸が
  // ずれ、本当は対称なマークが非対称と判定される（実測: 生成した正面のゴリラ
  // 3 枚のうち 2 枚が、中央だと 94〜96% で不合格、0.05〜0.06 ずらすと 99〜100%）。
  // 候補が渡されていればそこだけ、無ければ中央の周りを探して最良を採る
  const mid = (minX + maxX) / 2
  let best = candidate ?? mid
  let bestScore = scoreAt(best)
  if (candidate === undefined) {
    const reach = span * 0.04
    const step = span * 0.005
    for (let a = mid - reach; a <= mid + reach + 1e-9; a += step) {
      const s = scoreAt(a)
      if (s > bestScore + 1e-9) {
        bestScore = s
        best = a
      }
    }
  }
  return bestScore >= 0.97 ? round(best) : null
}

/**
 * 軸をはさんで対になる輪郭を探す。
 *
 * 自分自身が対称な要素だけを揃えても足りない。十字の 4 つの抜きのように、
 * 個々は非対称でも対で鏡像になっている要素があり、別々に当てはめると
 * 対応する弧が食い違う（実測: 丸に十字で弧の鏡像一致 68%）。
 *
 * 返すのは「相方の添字」。自分が対称なもの、相方が無いものは null。
 */
export function mirrorPairs(contours: Vec[][], axis: number, tolerance = 0.03): (number | null)[] {
  const boxOf = (c: Vec[]) => {
    const xs = c.map((q) => q.x)
    const ys = c.map((q) => q.y)
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }
  const boxes = contours.map(boxOf)
  const span = Math.max(...boxes.map((b) => Math.max(b.x1 - b.x0, b.y1 - b.y0)), 1e-6)
  const tol = span * tolerance

  const out: (number | null)[] = contours.map(() => null)
  for (let i = 0; i < contours.length; i++) {
    if (out[i] !== null) continue
    if (mirrorAxis(contours[i], axis) !== null) continue // 自分で対称なら対は不要

    const a = boxes[i]
    for (let j = i + 1; j < contours.length; j++) {
      if (out[j] !== null) continue
      const b = boxes[j]
      // まず外接枠で粗く篩う
      if (
        Math.abs(2 * axis - a.x1 - b.x0) > tol ||
        Math.abs(2 * axis - a.x0 - b.x1) > tol ||
        Math.abs(a.y0 - b.y0) > tol ||
        Math.abs(a.y1 - b.y1) > tol
      ) {
        continue
      }

      // 外接枠だけでは足りない。二つ巴の 2 つの巴は鏡像ではなく 180 度回転で、
      // 枠は一致するのに形は反転していない。誤って対とみなすと形が壊れる
      // （実測: 一致率 99.8% → 69%）。点の対応まで確かめる。
      const cell = tol
      const grid = new Set(
        contours[j].map((q) => `${Math.round(q.x / cell)}:${Math.round(q.y / cell)}`),
      )
      let hit = 0
      for (const q of contours[i]) {
        const mx = Math.round((2 * axis - q.x) / cell)
        const my = Math.round(q.y / cell)
        for (let dx = -1; dx <= 1 && hit === hit; dx++) {
          let found = false
          for (let dy = -1; dy <= 1; dy++) {
            if (grid.has(`${mx + dx}:${my + dy}`)) {
              found = true
              break
            }
          }
          if (found) {
            hit++
            break
          }
        }
      }
      if (hit / contours[i].length >= 0.97) {
        out[i] = j
        out[j] = i
        break
      }
    }
  }
  return out
}

/**
 * 閉じた輪郭の弧列を、軸で反転したものに直す。
 *
 * 反転すると回る向きが変わり、逆順に辿ることでもう一度変わるので、
 * 2 つが打ち消し合って向きは元のまま。半径は「その点へ入る弧」に属するため、
 * 逆順では 1 つずれた弧のものを引き継ぐ。
 */
export function mirrorSegments(segments: ContourSegment[], axis: number): ContourSegment[] {
  const n = segments.length
  return Array.from({ length: n }, (_, k) => {
    const point = segments[(n - 1 - k + n) % n]
    const arc = segments[(n - k) % n]
    return {
      x: round(2 * axis - point.x),
      y: round(point.y),
      r: arc.r,
      sweep: arc.sweep,
    }
  })
}

/** 対称軸を横切る位置を探す */
function axisCrossings(points: Vec[], axis: number): number[] {
  const out: number[] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i].x - axis
    const b = points[(i + 1) % points.length].x - axis
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) out.push(i)
  }
  return out
}

/**
 * 輪郭が 1 つの円そのものなら、その円を返す。
 *
 * 円を円弧の列として扱うのは無駄が多い。SVG の弧は 180 度を超えられないので
 * 最低 3 本に割れ、その 3 本が別々に半径を持ち、別々に丸められて食い違う
 * （実測: 半径 0.655 の円が 0.667 / 0.667 / 0.625 の 3 本になった）。
 * 設計図にも同じ円が 3 つ重なり、半径線が 6 本引かれる。
 *
 * 円と分かれば 1 つの円として持てる。形は正確になり、作図線も 1 本で済む。
 */
export function detectCircle(points: Vec[]): { cx: number; cy: number; r: number } | null {
  if (points.length < 12) return null
  const c = fitCircle(points)
  if (!c || c.r <= 0) return null
  // 半径の 1.2% 以内に全点が乗っていれば円とみなす
  return maxDeviation(points, c) <= c.r * 0.012 ? c : null
}

/**
 * 輪郭の複雑さ。向きの変化の総量（絶対曲率の積分）で測る。
 *
 * 円は大きさによらず 2π になり、こぶや切れ込みが増えるほど大きくなる。
 * 「円弧を何本必要とするか」に直結する量で、大きさとは独立している。
 */
export function contourComplexity(points: Vec[]): number {
  const n = points.length
  if (n < 3) return 0

  let total = 0
  let prev = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x)
  for (let i = 1; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (Math.hypot(dx, dy) < 1e-9) continue
    const dir = Math.atan2(dy, dx)
    total += Math.abs(angleDelta(prev, dir))
    prev = dir
  }
  return total
}

/**
 * 輪郭ごとの円弧の本数を決める。
 *
 * 大きさで配ってはいけない。小さくても複雑な輪郭（腕と脚の間の抜きなど）は
 * 本数が足りないと形が潰れ、大きくても単純な輪郭は本数を余らせる。
 * 曲がりの総量で配ると、必要な場所に必要なだけ回る。
 */
export function allocateArcs(contours: Vec[][], total: number, min = 3): number[] {
  if (contours.length === 0) return []
  const weights = contours.map((c) => Math.max(contourComplexity(c), 0.1))
  const sum = weights.reduce((a, b) => a + b, 0)
  // 最低本数を先に確保し、残りを重みで配る
  const pool = Math.max(total - min * contours.length, 0)
  return weights.map((w) => min + Math.round((pool * w) / sum))
}

/**
 * 点列をモジュール単位・原点中心へ正規化する。
 *
 * 素材の座標系（SVG の viewBox は 0〜1024 など様々）をそのまま使うと、
 * 半径の候補集合ともグリッドとも噛み合わない。
 */
export function fitToModule(contours: Vec[][], span = 5): Vec[][] {
  const all = contours.flat()
  if (all.length === 0) return []

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const q of all) {
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }

  // 変換は全輪郭で共通にすること。輪郭ごとに正規化すると抜きが外形と
  // 揃わず、目や口が別の場所へ飛ぶ。
  const scale = span / Math.max(maxX - minX, maxY - minY, 1e-6)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return contours.map((points) =>
    points.map((q) => ({
      x: round((q.x - cx) * scale),
      y: round((q.y - cy) * scale),
    })),
  )
}
