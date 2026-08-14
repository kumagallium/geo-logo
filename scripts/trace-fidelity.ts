/**
 * トレース結果が元の形とどれだけ一致しているかを測る。
 *
 *   pnpm tsx scripts/trace-fidelity.ts input.svg [円弧の総本数]
 *
 * 目で見て「だいたい合っている」と言うのを避けるための道具。
 * 対称差（食い違った面積）を元の面積で割った値を出す。
 */
import { readFileSync } from 'node:fs'
import { getPaper, resetProject } from '../src/core/paper-setup.js'
import {
  allocateArcs,
  detectCircle,
  fitToModule,
  harmonizeRadii,
  mirrorPairs,
  mirrorSegments,
  nestingDepth,
  sampleContoursFromSvg,
  traceArcs,
} from '../src/core/trace.js'
import { compile } from '../src/core/index.js'
import type { Shape, Step } from '../src/core/index.js'
import type { ContourSegment } from '../src/core/trace.js'

const [file, arcs = '28', tol] = process.argv.slice(2)
// 第 3 引数を渡すと、本数ではなく精度（輪郭の大きさに対する比）で決める
const tolerance = tol ? Number(tol) : 0
const svg = readFileSync(file, 'utf8')

const traced = sampleContoursFromSvg(svg)
const contours = fitToModule(traced.map((t) => t.points))
if (contours.length === 0) {
  console.error('塗りの形が取れませんでした')
  process.exit(1)
}

// 対称軸はマーク全体で 1 つに決める
const every = contours.flat()
const markAxis = (Math.min(...every.map((q) => q.x)) + Math.max(...every.map((q) => q.x))) / 2

const pairs = mirrorPairs(contours, markAxis)
const quota = allocateArcs(contours, Number(arcs))
const depth = nestingDepth(contours)
/** 当てはめ済みの弧列。対の相方を反転して作るために持っておく */
const done = new Map<number, ContourSegment[]>()
const shapes: Shape[] = []
const steps: Step[] = []
contours.forEach((points, i) => {
  const op = traced[i].solid ? ('add' as const) : ('sub' as const)
  const circle = detectCircle(points)
  if (circle) {
    shapes.push({ kind: 'circle', id: `c${i}`, cx: circle.cx, cy: circle.cy, r: circle.r, pinned: true })
    steps.push({ op, ref: `c${i}` })
    return
  }
  // 対で鏡像になっている相方は、当てはめ直さず反転して作る。
  // 別々に当てはめると対応する弧が食い違い、作図として体系に載らない
  const twin = pairs[i]
  const segments =
    twin !== null && twin < i && done.has(twin)
      ? mirrorSegments(done.get(twin) as ContourSegment[], markAxis)
      : traceArcs(points, tolerance ? { toleranceRatio: tolerance, mirrorX: markAxis } : { maxArcs: quota[i], mirrorX: markAxis }).segments
  done.set(i, segments)
  if (segments.length < 3) return
  shapes.push({ kind: 'contour', id: `c${i}`, segments })
  steps.push({ op, ref: `c${i}` })
})
// マーク全体で使われている半径を、少数の代表値へ揃える
const contourShapes = shapes.filter((x) => x.kind === 'contour')
const tuned = harmonizeRadii(contourShapes.map((x) => (x.kind === 'contour' ? x.segments : [])))
contourShapes.forEach((x, i) => {
  if (x.kind === 'contour') x.segments = tuned.groups[i]
})

const order = shapes.map((_, i) => i).sort((a, b) => depth[a] - depth[b])

const result = compile({
  name: 'fidelity',
  concept: '-',
  module: 64,
  grid: 'golden',
  palette: { primary: '#111111', secondary: '#8A8A8A', accent: '#C2410C', background: '#FFFFFF' },
  shapes,
  constraints: [],
  groups: [],
  parts: [{ id: 'mark', steps: order.map((i) => steps[i]), fill: 'primary', mirror: 'none' }],
})

// 元の形を、同じ正規化座標で組み立て直す。
// 順序は結果と同じく外側からにすること。ここを揃えないと参照側が壊れ、
// 一致率が結果ではなく測り方の誤りを表してしまう
const p = getPaper()
resetProject()
const M = result.design.module
const original = order.reduce<paper.PathItem | null>((acc, i) => {
  const path = new p.Path(contours[i].map((q) => new p.Point(q.x * M, q.y * M)))
  path.closed = true
  if (!acc) return traced[i].solid ? path : (path.remove(), null)
  const next = traced[i].solid ? acc.unite(path) : acc.subtract(path)
  acc.remove()
  path.remove()
  return next
}, null)

const built = new p.CompoundPath(result.built.parts.map((x) => x.pathData).join(' '))
const abs = (x: paper.PathItem | null) => Math.abs((x as unknown as { area?: number })?.area ?? 0)

if (!original) {
  console.error('元の形を組み立てられませんでした')
  process.exit(1)
}
const diff = original.exclude(built)
const ratio = abs(diff) / Math.max(abs(original), 1e-9)
const circles = shapes.filter((s) => s.kind === 'circle').length
const total = shapes.reduce((n, s) => n + (s.kind === 'contour' ? s.segments.length : 0), 0)
const lines = shapes.reduce(
  (n, s) => n + (s.kind === 'contour' ? s.segments.filter((g) => g.r === undefined).length : 0),
  0,
)
resetProject()

console.log(
  `${file.split('/').pop()}: 一致率 ${((1 - ratio) * 100).toFixed(2)}% / ` +
    `円 ${circles} + 円弧 ${total - lines} + 直線 ${lines} / ` +
    `異なる半径 ${tuned.radii.length} 種 / 作図線 ${result.built.construction.length}`,
)
