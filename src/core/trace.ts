import type { Contour } from './dsl'
import { getPaper, resetProject } from './paper-setup'
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
function fitPass(points: Vec[], tol: number): ContourSegment[] {
  const n = points.length
  const segments: ContourSegment[] = []
  let start = 0
  let guard = 0

  while (start < n && guard++ < n * 2) {
    let end = Math.min(start + 3, n)
    let accepted: { end: number; c: ReturnType<typeof fitCircle> } | null = null

    while (end <= n) {
      const window = points.slice(start, end + 1)
      const c = fitCircle(window)

      if (c) {
        if (maxDeviation(window, c) > tol) break
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
    const from = points[start]
    const to = points[Math.min(stop, n - 1)]
    const c = accepted?.c ?? null

    if (c) {
      // 膨らむ向きは、当てた円の中心から見た角度が増える向きかどうかで決まる。
      // 弦と中点の位置関係から推定すると符号を取り違えやすく、実際に輪郭が
      // 内側へ膨らんで棘だらけの星形になった。中心があるなら中心から測る。
      const a0 = Math.atan2(from.y - c.cy, from.x - c.cx)
      const a1 = Math.atan2(to.y - c.cy, to.x - c.cx)
      // SVG は y 下向きなので、角度が増える向き＝見た目の時計回り＝sweep 1
      segments.push({
        x: round(to.x),
        y: round(to.y),
        r: round(c.r),
        sweep: angleDelta(a0, a1) > 0,
      })
    } else {
      segments.push({ x: round(to.x), y: round(to.y), sweep: true })
    }

    if (stop >= n - 1) break
    start = stop
  }
  return segments
}

const round = (v: number) => Math.round(v * 1000) / 1000

export type TraceOptions = {
  /** 目標の円弧本数。少ないほど抽象度が上がる */
  maxArcs?: number
  /** 半径を比例体系の候補へ寄せるか */
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
export function traceArcs(points: Vec[], options: TraceOptions = {}): TraceResult {
  const maxArcs = Math.max(3, Math.min(options.maxArcs ?? 12, 64))
  if (points.length < 8) return { segments: [], tolerance: 0 }

  // 許容誤差を二分探索する。大きくすると本数が減る単調な関係なので収束する。
  let lo = 0.002
  let hi = 1.5
  let best = fitPass(points, hi)

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const segments = fitPass(points, mid)
    if (segments.length > maxArcs) {
      lo = mid
    } else {
      best = segments
      hi = mid
    }
  }

  const segments =
    options.snapRadii === false ? best : best.map((s) => (s.r === undefined ? s : snapRadius(s)))

  return { segments, tolerance: round(hi) }
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
