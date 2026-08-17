import type { LogoDesign, Shape, Step } from './dsl'
import {
  fitToModule,
  harmonizeRadii,
  mirrorAxis,
  mirrorPairs,
  mirrorSegments,
  nestingDepth,
  smoothJoints,
  traceArcs,
  type ContourSegment,
  type TracedContour,
  type Vec,
} from './trace'

/**
 * 画素の塊から作図を復元する。
 *
 * ここまでのやり方は「モデルに幾何を書かせる」順方向だった。関係を書かせても
 * ラフの点を書かせても、**構図と白の切り方をモデルが幾何の言葉で決めなければ
 * ならない**。それが届かないので、出来上がりが素人の絵になる。
 *
 * 順序を入れ替える。**先に絵として作らせ、その絵から作図を起こす。** 絵を作る
 * のは画像モデルの得意な仕事で、幾何は後から当てる。`trace.ts` は元々この
 * 後半のために書かれていて（既にある形から円弧列を復元する）、足りていなかった
 * のは「画素から輪郭を取り出す」この一段だけだった。
 *
 * 副産物として**入れ子が正しく出る**。輪郭の包含の深さがそのまま
 * add / sub / add の順になるので、囲いの中に塊を置く構成が自然に書ける。
 */

/** 画素が墨かどうか。範囲外は紙とみなす */
export type Mask = (x: number, y: number) => boolean

const round = (v: number) => Math.round(v * 1000) / 1000

/** DSL の 1 輪郭あたりの上限（contourSchema.segments） */
const MAX_SEGMENTS = 64

/**
 * 墨と紙の境目を、画素の格子上の閉じた折れ線として取り出す。
 *
 * 画素をなぞる方式（Moore 近傍）は斜めの扱いで穴が開くことがある。**画素の
 * 「隙間」を辿る**と、境界は必ず格子の上の単位辺の集合になり、各頂点で
 * 出入りの数が揃うので、閉じることが構成上保証される。
 *
 * 墨が進行方向の右へ来る向きに揃える。外周は時計回り、抜きは反時計回りで
 * 出るが、内外の判定は包含（nestingDepth）で決めるので向きには頼らない。
 */
export function contoursFromMask(ink: Mask, width: number, height: number): Vec[][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && ink(x, y)
  const key = (x: number, y: number) => y * (width + 1) + x
  const edges = new Map<number, Vec[]>()
  const push = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay)
    const list = edges.get(k)
    if (list) list.push({ x: bx, y: by })
    else edges.set(k, [{ x: bx, y: by }])
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue
      if (!at(x, y - 1)) push(x, y, x + 1, y)
      if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1)
      if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1)
      if (!at(x - 1, y)) push(x, y + 1, x, y)
    }
  }

  const loops: Vec[][] = []
  const guard = width * height * 4 + 16
  while (edges.size > 0) {
    const startKey = edges.keys().next().value as number
    const sx = startKey % (width + 1)
    const sy = (startKey - sx) / (width + 1)
    const loop: Vec[] = []
    let cx = sx
    let cy = sy
    let dx = 0
    let dy = 0

    for (let step = 0; step < guard; step++) {
      const list = edges.get(key(cx, cy))
      if (!list || list.length === 0) break

      // 鞍点（墨が斜めにだけ繋がる点）では辺が 2 本出る。**最も右へ曲がる方**を
      // 選ぶと、斜めに触れているだけの塊が切り離される。島の判定（islandsOf）が
      // 4 近傍なので、そちらと同じ見方に揃える
      let pick = 0
      if (list.length > 1 && (dx !== 0 || dy !== 0)) {
        let best = Number.NEGATIVE_INFINITY
        list.forEach((n, i) => {
          const ex = n.x - cx
          const ey = n.y - cy
          const turn = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey)
          if (turn > best) {
            best = turn
            pick = i
          }
        })
      }

      const next = list.splice(pick, 1)[0]
      if (list.length === 0) edges.delete(key(cx, cy))
      loop.push({ x: cx, y: cy })
      dx = next.x - cx
      dy = next.y - cy
      cx = next.x
      cy = next.y
      if (cx === sx && cy === sy) break
    }
    if (loop.length >= 4) loops.push(loop)
  }
  return loops
}

/** 点列の外接寸法（長辺） */
function spanOf(points: Vec[]): number {
  if (points.length === 0) return 0
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
}

/** 多角形の符号なし面積 */
function areaOf(points: Vec[]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

/**
 * 階段を落とす（Ramer–Douglas–Peucker）。
 *
 * 画素の境界は 1 画素刻みの階段で、そのまま円弧を当てると**段そのものに
 * 弧が当たる**。許容誤差を 1 画素より大きく取れば階段は消え、斜辺は直線に
 * 戻る。ここを飛ばすと本数がいくらあっても足りない。
 */
function simplify(points: Vec[], epsilon: number): Vec[] {
  const n = points.length
  if (n < 4) return points

  // 閉じた輪を開いた折れ線として扱うため、端を「最も外側の点」に置く。
  // どこで切っても良いわけではなく、直線の途中で切ると角が 1 つ増える
  let anchor = 0
  for (let i = 1; i < n; i++) {
    const p = points[i]
    const q = points[anchor]
    if (p.y < q.y || (p.y === q.y && p.x < q.x)) anchor = i
  }
  const rolled = [...points.slice(anchor), ...points.slice(0, anchor)]
  rolled.push(rolled[0])

  const keep = new Uint8Array(rolled.length)
  keep[0] = 1
  keep[rolled.length - 1] = 1
  const stack: [number, number][] = [[0, rolled.length - 1]]
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number]
    if (to - from < 2) continue
    const a = rolled[from]
    const b = rolled[to]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const len = Math.hypot(vx, vy)
    let worst = -1
    let far = 0
    for (let i = from + 1; i < to; i++) {
      const p = rolled[i]
      const d =
        len < 1e-9
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(vx * (a.y - p.y) - vy * (a.x - p.x)) / len
      if (d > far) {
        far = d
        worst = i
      }
    }
    if (far > epsilon && worst > 0) {
      keep[worst] = 1
      stack.push([from, worst], [worst, to])
    }
  }

  const out: Vec[] = []
  for (let i = 0; i < rolled.length - 1; i++) if (keep[i]) out.push(rolled[i])
  return out.length >= 3 ? out : points
}

/** 折れ線を弧長で等間隔に打ち直す。当てはめは点の密度が揃っている前提 */
function resample(points: Vec[], count: number): Vec[] {
  const n = points.length
  if (n < 3) return points
  const seg: number[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const q = points[(i + 1) % n]
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    seg.push(d)
    total += d
  }
  if (total < 1e-9) return points

  const out: Vec[] = []
  let i = 0
  let walked = 0
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count
    while (i < n - 1 && walked + seg[i] < target) {
      walked += seg[i]
      i++
    }
    const p = points[i]
    const q = points[(i + 1) % n]
    const t = seg[i] < 1e-9 ? 0 : (target - walked) / seg[i]
    out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  }
  return out
}

export type RasterOptions = {
  /** 墨とみなす明度の上限（0〜255） */
  threshold?: number
  /** 総面積に対してこれ未満の島は捨てる。生成画像の滲みを拾わないため */
  minArea?: number
  /** 打ち直す点の数 */
  samples?: number
  /**
   * 白黒が反転した絵を直すか。既定は自動。
   *
   * 「黒地に白抜き」で来ることがある。指示しても画像モデルは時々反転させるし、
   * 家紋の corpus は 74% がその構造だった。反転したまま通すと、外周が紙面いっぱいの
   * 四角になり、主題のほうが「抜き」として扱われる——**静かに壊れる**ので自動で直す。
   */
  invert?: boolean | 'auto'
}

/** 縁が墨で埋まっているか。埋まっていれば白黒が逆に来ている */
function looksInverted(gray: Uint8Array, width: number, height: number, threshold: number): boolean {
  let ink = 0
  let total = 0
  const check = (x: number, y: number) => {
    total++
    if (gray[y * width + x] < threshold) ink++
  }
  for (let x = 0; x < width; x++) {
    check(x, 0)
    check(x, height - 1)
  }
  for (let y = 1; y < height - 1; y++) {
    check(0, y)
    check(width - 1, y)
  }
  return total > 0 && ink / total > 0.6
}

/**
 * 画素から輪郭を取り出す。`sampleContoursFromSvg` と同じ形を返すので、
 * その先の工程（当てはめ・畳み込み・接線合わせ）はそのまま使える。
 */
export function contoursFromRaster(
  gray: Uint8Array,
  width: number,
  height = width,
  options: RasterOptions = {},
): TracedContour[] {
  const threshold = options.threshold ?? 128
  // 0.2% にしていたら、**小さいが意味のある白**まで捨てていた（実測: 生成した
  // ゴリラの眉間の皺 0.1%、口角の切れ込み 0.04% が消えて、表情が変わった）。
  // 本物のゴミは 1 画素程度（0.0003%）なので、桁を 2 つ下げても分けられる
  const minArea = options.minArea ?? 0.0002
  const samples = options.samples ?? 720

  const flip =
    options.invert === undefined || options.invert === 'auto'
      ? looksInverted(gray, width, height, threshold)
      : options.invert
  const isInk = flip
    ? (x: number, y: number) => gray[y * width + x] >= threshold
    : (x: number, y: number) => gray[y * width + x] < threshold

  const loops = contoursFromMask(isInk, width, height)
  if (loops.length === 0) return []

  // 生成画像には滲みやアンチエイリアスの取りこぼしが出る。**大きい塊に対して**
  // 小さすぎるものを捨てる（絶対値で切ると小さなマークごと消える）
  const areas = loops.map(areaOf)
  const largest = Math.max(...areas)
  const kept = loops.filter((_, i) => areas[i] >= largest * minArea)
  if (kept.length === 0) return []

  const epsilon = Math.max(1, Math.max(width, height) * 0.004)
  const clean = kept.map((loop) => resample(simplify(loop, epsilon), samples))
  const depth = nestingDepth(clean)
  return clean.map((points, i) => ({ points, solid: depth[i] % 2 === 0 }))
}

export type ReconstructOptions = {
  name?: string
  concept?: string
  /**
   * 当てはめの許容誤差。マークの外接寸法に対する比。
   *
   * **抽象度のレバーはここ 1 つ**。本数で指定する口もあるが、二分探索が上限
   * いっぱいまで刻もうとして冗長な弧が並び、しかも精度が落ちる（実測: 二つ巴で
   * 16 本 99.94%、28 本 99.55%）。誤差で切れば本数は自然に最小になる。
   *
   * 比はマーク全体に対して取る。輪郭ごとの大きさに対して取ると、小さな部品
   * だけが細かく刻まれて粗さが揃わない。
   */
  tolerance?: number
  /**
   * 1 つの輪郭が、自分自身の大きさに対して許す誤差の上限。
   *
   * マーク基準だけで切ると**小さな部品が溶ける**。実測: 家紋の花芯や葉の刻みが
   * 一様な塊になり、主題が読めなくなった（マークの 1.2% は、マークの 1/10 の
   * 部品にとっては 12% にあたる）。粗さを揃えることと、部品を残すことの折り合い。
   */
  detail?: number
  /** 半径の種類の上限。届くまで許容差を広げる。省略なら当てはめ誤差を畳むだけ */
  radii?: number
  /** 左右対称に寄せるか。省略なら点列から判定する */
  symmetry?: boolean
  palette?: LogoDesign['palette']
}

/**
 * 復元した輪郭から設計を組み立てる。
 *
 * 演算は**包含の深さ順**にする。深さ 0 が塗り、1 が抜き、2 がまた塗り。
 * 手で書く経路では「抜きは最後にまとめる」しかなく、囲いの中へ塊を置けな
 * かったが、復元では深さが画素から分かるので入れ子がそのまま出る。
 */
export function buildFromContours(
  contours: TracedContour[],
  options: ReconstructOptions = {},
): LogoDesign {
  const raw = contours.map((c) => c.points)
  const fitted = fitToModule(raw, 5)
  const depth = nestingDepth(fitted)

  const axis = options.symmetry === false ? null : mirrorAxis(fitted.flat())
  const mark = spanOf(fitted.flat())
  const tolerance = (options.tolerance ?? 0.02) * mark
  const detail = options.detail ?? 0.03

  // 軸をはさんで対になる輪郭は、片方だけ当てはめて反転で作る。別々に当てると
  // 対応する弧が食い違い、左右の目・眉が微妙に違う形になる（生成画像は素で
  // わずかに非対称なので、放っておくとその歪みをそのまま作図に写してしまう）
  const pairs = axis === null ? fitted.map(() => null) : mirrorPairs(fitted, axis)
  const done = new Map<number, ContourSegment[]>()

  const shapes: Shape[] = []
  const placed: { id: string; depth: number }[] = []
  fitted.forEach((points, i) => {
    const twin = pairs[i]
    if (twin !== null && axis !== null && done.has(twin)) {
      const mirrored = mirrorSegments(done.get(twin) as ContourSegment[], axis)
      shapes.push({ kind: 'contour', id: `r${i}`, segments: mirrored })
      placed.push({ id: `r${i}`, depth: depth[i] })
      done.set(i, mirrored)
      return
    }

    // traceArcs は比を「その輪郭の大きさ」に掛けるので、マーク基準の絶対値へ
    // 直してから渡す。こうしないと小さな部品だけ細かく刻まれる。
    // ただしマーク基準だけだと今度は小さな部品が溶けるので、部品自身に対する
    // 比でも頭を抑える
    const own = Math.max(spanOf(points), 1e-6)
    const wanted = Math.min(tolerance / own, detail)

    // DSL は 1 輪郭 64 セグメントまで。**超えるとスキーマが設計ごと拒む**ので、
    // 収まるまでその輪郭だけ許容誤差を緩める。上限は「LLM に書かせる輪郭」を
    // 想定した値で、復元が作る輪郭はそれより細かくなりうる（実測: 歩くゴリラの
    // 外周は、筋の切れ込みを含むので誤差 0.006 で 64 を超えた）。
    //
    // 一律に緩めるのではなく、はみ出した輪郭だけ緩める。他の部品まで巻き添えに
    // すると、1 本の複雑さがマーク全体の粗さを決めてしまう
    let segments: ContourSegment[] = []
    for (let relax = 1; relax <= 8; relax *= 1.5) {
      const { segments: fit } = traceArcs(points, {
        toleranceRatio: wanted * relax,
        mirrorX: axis ?? undefined,
        symmetry: axis !== null,
        // 元の形が設計そのものなので、比例体系へは寄せない（寄せると壊れる）
        snapRadii: false,
      })
      segments = smoothJoints(fit)
      if (segments.length <= MAX_SEGMENTS) break
    }
    if (segments.length > MAX_SEGMENTS) segments = segments.slice(0, MAX_SEGMENTS)
    if (segments.length < 3) return
    shapes.push({ kind: 'contour', id: `r${i}`, segments })
    placed.push({ id: `r${i}`, depth: depth[i] })
    done.set(i, segments)
  })

  if (shapes.length === 0) {
    fitted.forEach((points, i) => {
      shapes.push({ kind: 'poly', id: `r${i}`, points: points.slice(0, 64) })
      placed.push({ id: `r${i}`, depth: depth[i] })
    })
  }

  // 半径を数種類へ揃える。当てはめ誤差のばらつきを畳むと「描かれたもの」が
  // 「作図されたもの」に見える。目標を渡されたら届くまで許容差を広げる
  const groups = shapes.map((s) => (s.kind === 'contour' ? s.segments : []))
  if (groups.some((g) => g.length > 0)) {
    let tuned = harmonizeRadii(groups)
    if (options.radii !== undefined) {
      for (let tol = 0.06; tuned.radii.length > options.radii && tol <= 0.8; tol += 0.04) {
        tuned = harmonizeRadii(groups, tol)
      }
    }
    shapes.forEach((s, i) => {
      if (s.kind === 'contour') s.segments = tuned.groups[i] as ContourSegment[]
    })
  }

  const steps: Step[] = [...placed]
    .sort((a, b) => a.depth - b.depth)
    .map((p) => ({ op: p.depth % 2 === 0 ? ('add' as const) : ('sub' as const), ref: p.id }))
  if (steps.length > 0 && steps[0].op !== 'add') steps[0] = { ...steps[0], op: 'add' }

  return {
    name: options.name ?? 'reconstructed',
    concept: options.concept ?? '画像から復元した作図',
    module: 64,
    grid: 'golden',
    palette: options.palette ?? {
      primary: '#111111',
      secondary: '#8A8A8A',
      accent: '#C2410C',
      background: '#FFFFFF',
    },
    shapes,
    constraints: [],
    groups: [],
    parts: [{ id: 'mark', steps, fill: 'primary', mirror: 'none' }],
  }
}

/** 画素から設計まで一息に。復元の入口。 */
export function reconstruct(
  gray: Uint8Array,
  width: number,
  height = width,
  options: ReconstructOptions & RasterOptions = {},
): LogoDesign {
  return buildFromContours(contoursFromRaster(gray, width, height, options), options)
}

/** 復元の忠実さ。元の画素と、復元した設計を焼き直した画素の一致率 */
export function fidelity(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let same = 0
  for (let i = 0; i < n; i++) if (a[i] < 128 === b[i] < 128) same++
  return round(same / n)
}

/** 墨の外接矩形 */
function inkBounds(gray: Uint8Array, width: number, height: number) {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] >= 128) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

/**
 * 位置と大きさを揃えてから比べる忠実さ。
 *
 * 焼き直しはマークを枠いっぱいに置き直すので、元の絵の余白や位置と画素が
 * 並ばない。素の一致率は**余白の取り方**を測ってしまう（実測: 同じ復元でも
 * 元画像の余白の違いだけで 97% と 87% に割れた）。墨の外接矩形どうしを重ねて、
 * **墨の中の一致**を数える。
 */
export function alignedFidelity(
  a: Uint8Array,
  aw: number,
  ah: number,
  b: Uint8Array,
  bw: number,
  bh: number,
  samples = 512,
): number {
  const ba = inkBounds(a, aw, ah)
  const bb = inkBounds(b, bw, bh)
  if (!ba || !bb) return 0
  const spanA = Math.max(ba.x1 - ba.x0 + 1, ba.y1 - ba.y0 + 1)
  const spanB = Math.max(bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1)
  const cxA = (ba.x0 + ba.x1 + 1) / 2
  const cyA = (ba.y0 + ba.y1 + 1) / 2
  const cxB = (bb.x0 + bb.x1 + 1) / 2
  const cyB = (bb.y0 + bb.y1 + 1) / 2

  // 双方の外接矩形を、同じ正規化座標（-0.5〜0.5、少し余白）で標本化する
  let same = 0
  let total = 0
  const pad = 1.06
  for (let j = 0; j < samples; j++) {
    for (let i = 0; i < samples; i++) {
      const u = ((i + 0.5) / samples - 0.5) * pad
      const v = ((j + 0.5) / samples - 0.5) * pad
      const ax = Math.floor(cxA + u * spanA)
      const ay = Math.floor(cyA + v * spanA)
      const bx = Math.floor(cxB + u * spanB)
      const by = Math.floor(cyB + v * spanB)
      const inkA = ax >= 0 && ay >= 0 && ax < aw && ay < ah && a[ay * aw + ax] < 128
      const inkB = bx >= 0 && by >= 0 && bx < bw && by < bh && b[by * bw + bx] < 128
      if (inkA === inkB) same++
      total++
    }
  }
  return round(same / total)
}
