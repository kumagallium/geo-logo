/**
 * 左右対称の素材に対して、当てはめた円弧が鏡像になっているかを測る。
 *
 *   pnpm tsx scripts/trace-symmetry.ts input.svg [円弧の総本数]
 *
 * 形が対称でも、当てはめを左右で独立に行えばアンカーの位置も半径も食い違う。
 * デザイナーの作図では、対称なモチーフはまず対称性を決めてから引く。
 * その差は完成形の見た目にはほぼ出ないが、作図としては別物になる。
 */
import { readFileSync } from 'node:fs'
import {
  allocateArcs,
  detectCircle,
  fitToModule,
  mirrorPairs,
  mirrorSegments,
  sampleContoursFromSvg,
  traceArcs,
} from '../src/core/trace.js'

const [file, arcs = '28'] = process.argv.slice(2)
const traced = sampleContoursFromSvg(readFileSync(file, 'utf8'))
const contours = fitToModule(traced.map((t) => t.points))
if (contours.length === 0) {
  console.error('塗りの形が取れませんでした')
  process.exit(1)
}

/** 全輪郭をまとめた左右対称軸。点集合を x で折り返して一致するかで測る */
const all = contours.flat()
const axis = (Math.min(...all.map((p) => p.x)) + Math.max(...all.map((p) => p.x))) / 2
const span = Math.max(...all.map((p) => p.x)) - Math.min(...all.map((p) => p.x))

/** 形そのものの対称性。折り返した点が元の点集合の近くにあるか */
function shapeSymmetry(): number {
  const grid = new Set(all.map((p) => `${Math.round(p.x * 30)}:${Math.round(p.y * 30)}`))
  let hit = 0
  for (const p of all) {
    const mx = Math.round((2 * axis - p.x) * 30)
    const my = Math.round(p.y * 30)
    if (
      grid.has(`${mx}:${my}`) ||
      grid.has(`${mx + 1}:${my}`) ||
      grid.has(`${mx - 1}:${my}`) ||
      grid.has(`${mx}:${my + 1}`) ||
      grid.has(`${mx}:${my - 1}`)
    ) {
      hit++
    }
  }
  return hit / all.length
}

// 対称軸はマーク全体で 1 つに決める
const every = contours.flat()
const markAxis = (Math.min(...every.map((q) => q.x)) + Math.max(...every.map((q) => q.x))) / 2

const pairs = mirrorPairs(contours, markAxis)
const quota = allocateArcs(contours, Number(arcs))
// 半径は「その点へ入る弧」に属する。鏡像では入りと出が入れ替わるので、
// 点どうしではなく弧（始点・終点・半径）どうしで比べる
type Arc = { x1: number; y1: number; x2: number; y2: number; r: number }
const done = new Map<number, ReturnType<typeof traceArcs>['segments']>()
const fittedArcs: Arc[] = []
contours.forEach((points, i) => {
  if (detectCircle(points)) return // 円は 1 つの円として持つので対象外
  const twin = pairs[i]
  const segs =
    process.env.SYM !== '0' && twin !== null && twin < i && done.has(twin)
      ? mirrorSegments(done.get(twin) as ReturnType<typeof traceArcs>['segments'], markAxis)
      : traceArcs(points, { maxArcs: quota[i], symmetry: process.env.SYM !== '0', mirrorX: markAxis })
          .segments
  done.set(i, segs)
  segs.forEach((g, j) => {
    const from = segs[(j - 1 + segs.length) % segs.length]
    fittedArcs.push({ x1: from.x, y1: from.y, x2: g.x, y2: g.y, r: g.r ?? 0 })
  })
})

if (fittedArcs.length === 0) {
  console.log(`${file.split('/').pop()}: 円弧なし（すべて円として認識）`)
  process.exit(0)
}

const tol = span * 0.02
const mirrored = (a: Arc, b: Arc) =>
  Math.abs(b.x1 - (2 * axis - a.x2)) < tol &&
  Math.abs(b.y1 - a.y2) < tol &&
  Math.abs(b.x2 - (2 * axis - a.x1)) < tol &&
  Math.abs(b.y2 - a.y1) < tol

let matched = 0
let worstR = 0
for (const a of fittedArcs) {
  const partner = fittedArcs.find((b) => mirrored(a, b))
  if (!partner) continue
  matched++
  if (a.r > 0) worstR = Math.max(worstR, Math.abs(partner.r - a.r) / a.r)
}

console.log(
  `${file.split('/').pop()}: 形の対称性 ${(shapeSymmetry() * 100).toFixed(0)}% / ` +
    `弧の鏡像一致 ${((matched / fittedArcs.length) * 100).toFixed(0)}% (${matched}/${fittedArcs.length}) / ` +
    `対応する半径の最大ずれ ${(worstR * 100).toFixed(1)}%`,
)
