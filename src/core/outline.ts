import { z } from 'zod'
import type { LogoDesign, Shape, Step } from './dsl'
import { fitToModule, harmonizeRadii, smoothJoints, traceArcs, type Vec } from './trace'

/**
 * 輪郭の通過点から作図する。
 *
 * 部品方式は円を詰めて形を作る。円を詰めると質量が平均化され、どんな題材も
 * 丸い団子になった（ゴリラの肩の張りが消える）。円は「面を埋める」道具で、
 * 「輪郭を決める」道具ではない。
 *
 * 家紋の逆算で作った機構——輪郭を円弧の連なりにする・継ぎ目の接線を揃える・
 * 半径を数種類に揃える——は既に動いている。足りなかったのは入力の側で、
 * 「円の中心と半径」ではなく「輪郭が通る点」を受け取れば、同じ機構がその
 * まま具象の輪郭に効く。画像を経由せず、順方向のまま具象へ届く道。
 */

const num = (min: number, max: number, fallback: number) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
      return Math.min(Math.max(n, min), max)
    })

const pointSchema = z.object({ x: num(-10, 10, 0), y: num(-10, 10, 0) })

export const outlineContourSchema = z.object({
  label: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v ?? '').slice(0, 24)),
  role: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return k === 'hole' || k === 'sub' || k === 'cut' ? ('hole' as const) : ('solid' as const)
    }),
  // 4 点未満では閉じた輪郭にならない。24 点を超えると点で形を決めることに
  // なり、円弧に均す意味が消える（＝トレースと同じになる）
  points: z.array(pointSchema).min(4).max(24),
})

export const outlineSchema = z.object({
  name: z.string().min(1).max(40),
  concept: z.string().min(1).max(600),
  /** 左右対称にするか。対称なら軸を 1 本に決めて、片側から反転する */
  symmetry: z
    .union([z.boolean(), z.string(), z.null()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  contours: z.array(outlineContourSchema).min(1).max(5),
})

export type OutlinePlan = z.infer<typeof outlineSchema> & { palette?: LogoDesign['palette'] }

/**
 * 通過点の間を滑らかに繋ぐ（中心化 Catmull-Rom）。
 *
 * 点をそのまま円弧に当てはめると、点の間隔がそのまま円弧の刻みになって
 * 折れる。先に滑らかな曲線を通してから当てはめると、点の数と円弧の本数が
 * 切り離せる（通過点 10 個から円弧 5 本、ということが起きる）。
 */
function interpolate(points: Vec[], perSegment = 16): Vec[] {
  const n = points.length
  if (n < 4) return points
  const at = (i: number) => points[((i % n) + n) % n]
  const out: Vec[] = []
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    // 中心化（α=0.5）。一様だと点が密なところで曲線が飛び出す
    const t = [0, 0, 0, 0]
    for (let k = 1; k < 4; k++) {
      const a = [p0, p1, p2, p3][k - 1]
      const b = [p0, p1, p2, p3][k]
      t[k] = t[k - 1] + Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) || t[k - 1] + 1e-6
    }
    for (let s = 0; s < perSegment; s++) {
      const tt = t[1] + ((t[2] - t[1]) * s) / perSegment
      const lerp = (a: Vec, b: Vec, ta: number, tb: number) => {
        const u = tb === ta ? 0 : (tt - ta) / (tb - ta)
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
      }
      const a1 = lerp(p0, p1, t[0], t[1])
      const a2 = lerp(p1, p2, t[1], t[2])
      const a3 = lerp(p2, p3, t[2], t[3])
      const b1 = lerp(a1, a2, t[0], t[2])
      const b2 = lerp(a2, a3, t[1], t[3])
      out.push(lerp(b1, b2, t[1], t[2]))
    }
  }
  return out
}

/** 左右対称にする。軸は x=0 に決め打つ（マーク全体で 1 本に揃えるため）。 */
function symmetrize(points: Vec[]): Vec[] {
  // 右半分だけを残し、折り返して閉じる。左右で点の数が違っても揃う
  const right = points.filter((p) => p.x >= 0)
  if (right.length < 3) return points
  const sorted = [...right].sort((a, b) => a.y - b.y)
  const back = [...sorted].reverse().map((p) => ({ x: -p.x, y: p.y }))
  return [...sorted, ...back]
}

export function buildFromOutline(plan: OutlinePlan): LogoDesign {
  const parsed = outlineSchema.parse(plan)

  const raw = parsed.contours.map((c) => (parsed.symmetry ? symmetrize(c.points) : c.points))
  // 紙面に収める。ここで揃えておかないと、点の絶対値がそのまま寸法になる
  const scaled = fitToModule(raw, 5)
  // 原点へ寄せる。寄せないと設計図で作図円が本体から離れた位置に描かれる
  const all = scaled.flat()
  const cx = (Math.min(...all.map((p) => p.x)) + Math.max(...all.map((p) => p.x))) / 2
  const cy = (Math.min(...all.map((p) => p.y)) + Math.max(...all.map((p) => p.y))) / 2
  const fitted = scaled.map((c) => c.map((p) => ({ x: p.x - cx, y: p.y - cy })))

  const shapes: Shape[] = []
  const steps: Step[] = []
  fitted.forEach((points, i) => {
    const dense = interpolate(points)
    // 本数ではなく許容誤差で切る。本数指定は冗長な弧を並べたうえ精度も落ちる
    const { segments: fit } = traceArcs(dense, {
      // 粗く切る。細かく刻むと点をなぞるだけになり、円弧に均す意味が消える
      toleranceRatio: 0.06,
      mirrorX: parsed.symmetry ? 0 : undefined,
      // 作図側では半径を比例体系へ寄せる。トレースでは元の形が設計なので
      // 寄せると壊れるが、こちらは寄せることが目的（作図した形にする）
      snapRadii: true,
    })
    const segments = smoothJoints(fit)
    if (segments.length < 3) return
    shapes.push({ kind: 'contour', id: `o${i}`, segments })
    steps.push({ op: parsed.contours[i].role === 'hole' ? 'sub' : 'add', ref: `o${i}` })
  })

  if (shapes.length === 0) {
    // 却下せず、点をそのまま多角形として出す。形は粗いが空にはならない
    fitted.forEach((points, i) => {
      shapes.push({ kind: 'poly', id: `o${i}`, points })
      steps.push({ op: parsed.contours[i].role === 'hole' ? 'sub' : 'add', ref: `o${i}` })
    })
  }

  // 半径を数種類へ揃える。ここが「描かれたもの」と「作図されたもの」を分ける。
  //
  // 家紋の実測では半径は 3〜5 種。既定の許容差（3%）はトレース用で、
  // 当てはめ誤差を畳むだけなので生成側では緩すぎない（14 種残った）。
  // 目標の種類数に届くまで許容差を広げる。
  const contours = shapes.filter((s) => s.kind === 'contour')
  if (contours.length > 0) {
    const groups = contours.map((s) => (s.kind === 'contour' ? s.segments : []))
    let tuned = harmonizeRadii(groups)
    for (let tol = 0.1; tuned.radii.length > 5 && tol <= 0.8; tol += 0.1) {
      tuned = harmonizeRadii(groups, tol)
    }
    contours.forEach((s, i) => {
      if (s.kind === 'contour') s.segments = tuned.groups[i]
    })
  }

  // 塗りを先に全部足してから抜く。演算順で全体が消える事故を防ぐ
  const ordered = [...steps.filter((s) => s.op === 'add'), ...steps.filter((s) => s.op === 'sub')]

  return {
    name: parsed.name,
    concept: parsed.concept,
    module: 64,
    grid: 'golden',
    palette: plan.palette ?? {
      primary: '#111111',
      secondary: '#8A8A8A',
      accent: '#C2410C',
      background: '#FFFFFF',
    },
    shapes,
    constraints: [],
    groups: [],
    parts: [{ id: 'mark', steps: ordered, fill: 'primary', mirror: 'none' }],
  }
}

/** 円弧の本数と半径の種類。作図されているかを測る。 */
export function outlineStats(design: LogoDesign): { arcs: number; radii: number } {
  const groups = design.shapes
    .filter((s) => s.kind === 'contour')
    .map((s) => (s.kind === 'contour' ? s.segments : []))
  const arcs = groups.reduce((n, g) => n + g.length, 0)
  return { arcs, radii: harmonizeRadii(groups).radii.length }
}
