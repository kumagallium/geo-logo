/**
 * SVG のシルエットを円弧の列へ還元して、幾何ロゴとして描き直す。
 *
 *   pnpm tsx scripts/trace-svg.ts input.svg 出力名 [円弧の総本数]
 *
 * 円弧の本数が抽象度そのもの。多いとトレースした絵、少ないとロゴになる。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Shape, Step } from '../src/core/index.js'
import type { ContourSegment } from '../src/core/trace.js'
import { compile } from '../src/core/index.js'
import {
  allocateArcs,
  detectCircle,
  fitToModule,
  mirrorPairs,
  mirrorSegments,
  nestingDepth,
  sampleContoursFromSvg,
  traceArcs,
} from '../src/core/trace.js'

const [file, out = 'trace', arcs = '12', tol] = process.argv.slice(2)
// 第 4 引数を渡すと、本数ではなく精度（輪郭の大きさに対する比）で決める
const tolerance = tol ? Number(tol) : 0
const svg = readFileSync(file, 'utf8')

const traced = sampleContoursFromSvg(svg)
const contours = fitToModule(traced.map((t) => t.points))
if (contours.length === 0) {
  // 線（stroke）だけで描かれた素材は扱えない。塗りの形が無いので円弧を
  // 当てる対象が存在しない。黙って別の形を出すより、扱えないと言うほうがよい
  console.error(
    '塗りの形が取れませんでした。線だけで描かれた素材（fill="none" + stroke）は対象外です。',
  )
  process.exit(1)
}

/** 当てはめ済みの弧列。対の相方を反転して作るために持っておく */
const done = new Map<number, ContourSegment[]>()
const shapes: Shape[] = []
const steps: Step[] = []
const budget = Number(arcs)

// 本数は大きさではなく曲がりの総量で配る。小さくても複雑な抜きが潰れないように
const quota = allocateArcs(contours, budget)
contours.forEach((points, i) => {
  const id = `c${i}`
  const op = traced[i].solid ? ('add' as const) : ('sub' as const)

  // 円は円として持つ。円弧の列にすると 3 本に割れて食い違い、
  // 設計図にも同じ円が 3 つ重なる
  const circle = detectCircle(points)
  if (circle) {
    // 素材の形が設計そのものなので、正規化で寸法を動かさない
    shapes.push({ kind: 'circle', id, cx: circle.cx, cy: circle.cy, r: circle.r, pinned: true })
    steps.push({ op, ref: id })
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
  shapes.push({ kind: 'contour', id, segments })
  steps.push({ op, ref: id })
})

// 外側から順に足し引きする。塗りを全部先に合体させてから抜くと、穴を抜いた
// 時点でその中にある実体まで消える（蛇の目の中心の点が消えた）
const depth = nestingDepth(contours)
const order = shapes.map((_, i) => i).sort((a, b) => depth[a] - depth[b])
const sorted = order.map((i) => steps[i])
steps.length = 0
steps.push(...sorted)

const result = compile({
  name: out,
  concept: `シルエットを ${shapes.length} 本の輪郭・計 ${shapes.reduce((n, s) => n + (s.kind === 'contour' ? s.segments.length : 0), 0)} 本の円弧へ還元`,
  module: 64,
  grid: 'golden',
  palette: { primary: '#111111', secondary: '#8A8A8A', accent: '#C2410C', background: '#FFFFFF' },
  shapes,
  constraints: [],
  groups: [],
  parts: [{ id: 'mark', steps, fill: 'primary', mirror: 'none' }],
})

mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)
writeFileSync(`tmp/${out}-poster.svg`, result.posterSvg)

const total = shapes.reduce((n, s) => n + (s.kind === 'contour' ? s.segments.length : 0), 0)
const solids = steps.filter((s) => s.op === 'add').length
console.log(
  `${out}: 実体 ${solids} + 抜き ${steps.length - solids} / 円弧 計${total} 本 / インク ${(result.built.inkRatio * 100).toFixed(0)}%`,
)
