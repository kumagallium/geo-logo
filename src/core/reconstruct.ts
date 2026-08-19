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
  /**
   * 左右対称に寄せるか。既定は自動（対称と判定できたときだけ）。
   *
   * 生成画像は**画素ではほぼ対称なのに、輪郭のつながり方が左右で違う**ことがある
   * ——片側だけ 1〜2 画素の橋で目が外周に繋がっている、など。輪郭を取り出して
   * から対称にしようとしても、位相が違うので原理的に直らない（実測: 顔の白が
   * 軸を 4 回横切り、右側の区間に相方が無かった）。**輪郭を取り出す前に、マスクを
   * 画素で対称化する**。片側をもう片側に写すので、位相まで揃う。
   */
  symmetrize?: boolean | 'auto'
  /**
   * 回す対称に寄せるか。既定は自動（回転対称と判定できたときだけ）。
   *
   * 鏡像は `symmetrizeMask` で揃うが、花・輪・車輪のような**回す対称**は
   * 手つかずだった。実測: 生成した桜は 5 回対称 85% で、花弁の大きさと間隔が
   * 揃っていない。数を渡せばその回数で強制する。
   */
  rotational?: boolean | 'auto' | number
}

/**
 * マスクの左右対称の軸を探し、対称なら片側を写して完全に対称にする。
 *
 * 軸は外接矩形の中央に決め打ちしない。片側の毛先が少し出るだけでずれる。
 * 中央の周りを半画素刻みで探し、墨の一致が最も高い位置を採る。
 * 一致が 97% に届かなければ対称ではないと見て何もしない。
 */
export function symmetrizeMask(
  ink: Uint8Array,
  width: number,
  height: number,
): { ink: Uint8Array; axis: number | null } {
  // 戻り値の型を素の Uint8Array にそろえる（`new Uint8Array(ink)` は ArrayBufferLike）
  let x0 = width
  let x1 = -1
  let y0 = height
  let y1 = -1
  let count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!ink[y * width + x]) continue
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (count < 64) return { ink, axis: null }

  // 標本は間引く。全画素で軸を掃引すると大きい絵で秒単位になる
  const stride = Math.max(1, Math.floor(Math.sqrt(count / 20000)))
  // 「鏡像の位置に墨があるか」を、その周囲まで許して数える。生成画像は素で
  // 数画素ずれているので、厳密一致だと本当は対称なマークが 96% 止まりで落ちる
  // （実測: 正面のゴリラで厳密 96.4%、輪郭点の判定（許容 2%）では 100%）。
  // 輪郭側と同じ 2% を画素に直して使う
  const slack = Math.max(1, Math.round((x1 - x0) * 0.02))
  const near = (x: number, y: number): boolean => {
    for (let dy = -slack; dy <= slack; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= height) continue
      for (let dx = -slack; dx <= slack; dx++) {
        const xx = x + dx
        if (xx >= 0 && xx < width && ink[yy * width + xx]) return true
      }
    }
    return false
  }
  const score = (axis2: number): number => {
    // axis2 は軸の 2 倍（半画素刻みを整数で扱う）。画素 x の鏡像は axis2 - 1 - x
    let hit = 0
    let seen = 0
    for (let y = y0; y <= y1; y += stride) {
      for (let x = x0; x <= x1; x += stride) {
        if (!ink[y * width + x]) continue
        seen++
        if (near(axis2 - 1 - x, y)) hit++
      }
    }
    return seen > 0 ? hit / seen : 0
  }

  const mid2 = x0 + x1 + 1
  const reach = Math.max(2, Math.round((x1 - x0) * 0.08))
  let best2 = mid2
  let bestScore = score(mid2)
  for (let a2 = mid2 - reach; a2 <= mid2 + reach; a2++) {
    const s = score(a2)
    if (s > bestScore + 1e-9) {
      bestScore = s
      best2 = a2
    }
  }
  if (bestScore < 0.97) return { ink, axis: null }

  // 左を右へ写す。どちらを正とするかは任意だが、揃えることが目的なので一貫させる
  const out: Uint8Array = Uint8Array.from(ink)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mx = best2 - 1 - x
      if (mx < x) continue // 右側だけ書き換える
      if (mx >= 0 && mx < width) out[y * width + mx] = ink[y * width + x]
    }
  }
  return { ink: out, axis: best2 / 2 }
}

/**
 * マスクの回転対称を探し、対称なら 1 区画を写して完全に対称にする。
 *
 * 鏡像は `symmetrizeMask` で既に揃えているが、**回す対称は手つかず**だった。
 * 実測（手元の生成画像 26 枚）: 桜が 5 回対称 85%、他は 50〜60% で地に沈む。
 * 15% のずれは目に見える——花弁の大きさと間隔が揃っていない。
 *
 * 直し方は鏡像と同じ考え方にする。**多数決は使わない。** 5 枚を重ねて過半で
 * 決めると、角度のずれた内部の白どうしが打ち消し合って粒になる（実測: 桜の
 * 花芯の切れ込みが消えて点の輪になった）。1 区画を選んで k 回写す。
 *
 * どの区画を種にするかは、写した結果が元の絵と最も合うもので決める。
 *
 * 「境目が墨の薄いところを通る区画を選ぶ」も試したが、**逆効果だった**
 * （実測: 桜で一致 91.5% → 87.6%。写した結果の合いは 90.8% で変わらないのに、
 * 下流の輪郭の取り出しだけが悪くなる）。合いだけで選ぶ。
 */
export function rotateSymmetrizeMask(
  ink: Uint8Array,
  width: number,
  height: number,
  options: { fold?: number; threshold?: number; margin?: number; floor?: number } = {},
): { ink: Uint8Array; fold: number | null; center: Vec | null; score: number; agree: number } {
  const none = { ink, fold: null, center: null, score: 0, agree: 0 }
  let x0 = width
  let x1 = -1
  let y0 = height
  let y1 = -1
  let sx = 0
  let sy = 0
  let count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!ink[y * width + x]) continue
      count++
      sx += x
      sy += y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (count < 64) return none

  const span = Math.max(x1 - x0, y1 - y0)
  const stride = Math.max(1, Math.floor(Math.sqrt(count / 20000)))
  // 鏡像側と同じ 2% の緩み。厳密一致だと、素で数画素ずれた生成画像が落ちる
  const slack = Math.max(1, Math.round(span * 0.02))
  // 緩みは**先に膨らませて 1 回の参照にする**。中心を探すために同じ判定を
  // 数百回繰り返すので、そのつど近傍を舐めると 512 画素角で分単位になる
  // （実測: 26 枚の判定が 2 分で終わらなかった）。縦横に分けた 1 次元の
  // 膨張なので、正方の近傍と同じ結果が O(画素数) で出る
  const wide = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!ink[y * width + x]) continue
      const lo = Math.max(0, x - slack)
      const hi = Math.min(width - 1, x + slack)
      for (let xx = lo; xx <= hi; xx++) wide[y * width + xx] = 1
    }
  }
  const dilated = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!wide[y * width + x]) continue
      const lo = Math.max(0, y - slack)
      const hi = Math.min(height - 1, y + slack)
      for (let yy = lo; yy <= hi; yy++) dilated[yy * width + x] = 1
    }
  }
  const near = (x: number, y: number): boolean => {
    const cx = Math.round(x)
    const cy = Math.round(y)
    return cx >= 0 && cy >= 0 && cx < width && cy < height && dilated[cy * width + cx] === 1
  }

  /** k 回対称の度合い。墨の画素を 1 区画ぶん回して、行き先に墨があるか */
  const score = (k: number, cx: number, cy: number): number => {
    const a = (2 * Math.PI) / k
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    let hit = 0
    let seen = 0
    for (let y = y0; y <= y1; y += stride) {
      for (let x = x0; x <= x1; x += stride) {
        if (!ink[y * width + x]) continue
        seen++
        const dx = x - cx
        const dy = y - cy
        if (near(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)) hit++
      }
    }
    return seen > 0 ? hit / seen : 0
  }

  // 回転中心は墨の重心の近くにあるが、そのものではない（花弁 1 枚が大きいだけで
  // ずれる）。重心の周りを探す
  const findCenter = (k: number): { cx: number; cy: number; s: number } => {
    let best = { cx: sx / count, cy: sy / count, s: 0 }
    for (let step = span * 0.04; step >= span * 0.005; step /= 2) {
      const from = { ...best }
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const cx = from.cx + i * step
          const cy = from.cy + j * step
          const s = score(k, cx, cy)
          if (s > best.s) best = { cx, cy, s }
        }
      }
    }
    return best
  }

  // 何回対称かは**大きい k から**見る。6 回対称のマークは 2 回でも 3 回でも
  // 高く出るので、点数の最大を採ると 2 回で止まる。
  //
  // ただし「点数が閾値を超えた最初の k」で確定させてはいけない。実測: 桜は
  // 6 回でも 91% 出るので、真の 5 回（99%）の手前で 6 回に決まり、そのあと
  // 区画を写した結果が元の絵と 67% しか合わずに丸ごと棄却されていた。
  // **写してみた結果で決める**——点数は候補を絞るためだけに使う。
  const threshold = options.threshold ?? 0.95
  const margin = options.margin ?? 0.06
  const floor = options.floor ?? 0.85
  const folds = options.fold !== undefined ? [options.fold] : [8, 7, 6, 5, 4, 3, 2]

  /** 種の区画を theta0 から取り、k 回写したマスク */
  const replicate = (fold: number, cx: number, cy: number, theta0: number): Uint8Array => {
    const seg = (2 * Math.PI) / fold
    const out = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx
        const dy = y - cy
        let a = Math.atan2(dy, dx) - theta0
        a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        // 種の区画へ戻す向きに回す
        const back = -Math.floor(a / seg) * seg
        const rx = Math.round(cx + dx * Math.cos(back) - dy * Math.sin(back))
        const ry = Math.round(cy + dx * Math.sin(back) + dy * Math.cos(back))
        if (rx >= 0 && ry >= 0 && rx < width && ry < height && ink[ry * width + rx]) {
          out[y * width + x] = 1
        }
      }
    }
    return out
  }

  const agree = (cand: Uint8Array): number => {
    let same = 0
    let seen = 0
    for (let y = y0; y <= y1; y += stride) {
      for (let x = x0; x <= x1; x += stride) {
        const a = ink[y * width + x] === 1
        const b = cand[y * width + x] === 1
        if (!a && !b) continue
        seen++
        if (a === b) same++
      }
    }
    return seen > 0 ? same / seen : 0
  }

  // 先に全部の回数を測る。**丸いマークは何回でも高く出る**ので、点数の絶対値
  // だけでは分けられない（実測: 向日葵と輪は 2〜8 回のどれもが 97〜100%）。
  // 他の回数から抜きん出ているかで見る
  const found = new Map<number, { cx: number; cy: number; s: number }>()
  for (const fold of folds) found.set(fold, findCenter(fold))
  const stands = (fold: number): boolean => {
    const others = folds.filter((k) => k !== fold).map((k) => (found.get(k) as { s: number }).s)
    if (others.length === 0) return true
    const sorted = [...others].sort((a, b) => a - b)
    const mid = sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    return (found.get(fold) as { s: number }).s - mid >= margin
  }

  let fallback = { score: 0, agree: 0 }
  for (const fold of folds) {
    const c = found.get(fold) as { cx: number; cy: number; s: number }
    if (options.fold === undefined && (c.s < threshold || !stands(fold))) continue
    // 種の区画を一周ぶん試す
    let best: { ink: Uint8Array; agree: number } | null = null
    const tries = 12 * fold
    for (let t = 0; t < tries; t++) {
      const theta0 = (2 * Math.PI * t) / tries
      const cand = replicate(fold, c.cx, c.cy, theta0)
      const a = agree(cand)
      if (!best || a > best.agree) best = { ink: cand, agree: a }
    }
    if (!best) continue
    if (best.agree > fallback.agree) fallback = { score: c.s, agree: best.agree }
    // 写した結果が元の絵から離れすぎたら、その回数ではなかったと見て次を見る
    if (best.agree < floor) continue
    return {
      ink: best.ink,
      fold,
      center: { x: c.cx, y: c.cy },
      score: c.s,
      agree: best.agree,
    }
  }
  return { ...none, ...fallback }
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
  // いったん二値のマスクにする。対称化は画素で行うのでここが要る
  let mask: Uint8Array = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (flip ? gray[i] >= threshold : gray[i] < threshold) ? 1 : 0
  }
  if (options.symmetrize !== false) {
    const sym = symmetrizeMask(mask, width, height)
    if (options.symmetrize === true || sym.axis !== null) mask = sym.ink
  }
  // 鏡像の後に回す。順序が逆だと、区画を写した時点で左右の揃えが崩れる
  if (options.rotational !== false) {
    const rot = rotateSymmetrizeMask(mask, width, height, {
      fold: typeof options.rotational === 'number' ? options.rotational : undefined,
    })
    if (rot.fold !== null) mask = rot.ink
  }

  const loops = contoursFromMask((x, y) => mask[y * width + x] === 1, width, height)
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
        // マーク全体が対称なら、軸をまたぐ輪郭は判定を飛ばして対称に作る。
        // 輪郭ごとの判定に任せると外周だけ対称で顔は非対称、という中途半端になる
        symmetry: axis !== null ? 'force' : false,
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

    // 畳んだあとに、対をもう一度鏡像で揃える。
    //
    // 対は片方だけ当てて鏡像で作っているが、その後の畳み込みは輪郭ごとに
    // 最寄りの代表値へ寄せるので、**同じ半径だった対が別々の値へ寄る**ことが
    // ある（実測: 左右の目が 6 本ずつ鏡像で作られたのに、畳んだ後は 6 頂点中
    // 0 しか相方が無かった）。畳むのは値を揃えるためなのに、対称を崩しては
    // 本末転倒なので、畳んでから相方を作り直す
    if (axis !== null) {
      const byId = new Map(shapes.map((s, i) => [s.id, i]))
      pairs.forEach((twin, i) => {
        if (twin === null || twin >= i) return
        const self = byId.get(`r${i}`)
        const other = byId.get(`r${twin}`)
        if (self === undefined || other === undefined) return
        const src = shapes[other]
        const dst = shapes[self]
        if (src.kind !== 'contour' || dst.kind !== 'contour') return
        dst.segments = mirrorSegments(src.segments, axis)
      })
    }
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
