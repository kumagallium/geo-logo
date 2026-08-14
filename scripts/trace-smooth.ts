/**
 * 隣り合う円弧の継ぎ目で、接線がどれだけ折れているかを測る。
 *
 *   pnpm tsx scripts/trace-smooth.ts input.svg [円弧の総本数]
 *
 * 円弧を独立に当てはめると、継ぎ目で接線が不連続になる（G0）。
 * 人の作図では接線を揃える（G1）ので、輪郭が流れて見える。
 */
import { readFileSync } from 'node:fs'
import {
  allocateArcs,
  smoothJoints,
  fitToModule,
  sampleContoursFromSvg,
  traceArcs,
  type ContourSegment,
} from '../src/core/trace.js'

const [file, arcs = '20'] = process.argv.slice(2)
const traced = sampleContoursFromSvg(readFileSync(file, 'utf8'))
const contours = fitToModule(traced.map((t) => t.points))
if (contours.length === 0) {
  console.error('塗りの形が取れませんでした')
  process.exit(1)
}

/** 弧の始点・終点における接線の向き */
function tangents(from: ContourSegment, seg: ContourSegment): [number, number] | null {
  if (seg.r === undefined) {
    const a = Math.atan2(seg.y - from.y, seg.x - from.x)
    return [a, a]
  }
  const dx = seg.x - from.x
  const dy = seg.y - from.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return null
  const r = Math.max(seg.r, d / 2)
  const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0))
  const mx = (from.x + seg.x) / 2
  const my = (from.y + seg.y) / 2
  const nx = -dy / d
  const ny = dx / d
  const sign = seg.sweep ? 1 : -1
  const cx = mx + sign * h * nx
  const cy = my + sign * h * ny
  // 接線は半径に直交する。回る向きで符号が決まる
  const t = (px: number, py: number) => Math.atan2(sign * (px - cx), -sign * (py - cy))
  return [t(from.x, from.y), t(seg.x, seg.y)]
}

const diff = (a: number, b: number) => {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return Math.abs(d)
}

const quota = allocateArcs(contours, Number(arcs))
let joints = 0
let kinked = 0
let worst = 0
let total = 0

contours.forEach((points, i) => {
  const raw = traceArcs(points, { maxArcs: quota[i] }).segments
  const segs = process.env.SMOOTH === '1' ? smoothJoints(raw) : raw
  for (let j = 0; j < segs.length; j++) {
    const prev = segs[(j - 1 + segs.length) % segs.length]
    const cur = segs[j]
    const next = segs[(j + 1) % segs.length]
    const a = tangents(prev, cur)
    const b = tangents(cur, next)
    if (!a || !b) continue
    const gap = (diff(a[1], b[0]) * 180) / Math.PI
    joints++
    total += gap
    if (gap > worst) worst = gap
    if (gap > 5) kinked++
  }
})

console.log(
  `${file.split('/').pop()}${process.env.SMOOTH === '1' ? '（接線を揃えた）' : ''}: 継ぎ目 ${joints} 箇所 / 平均のずれ ${(total / Math.max(joints, 1)).toFixed(1)}° / ` +
    `最大 ${worst.toFixed(1)}° / 5° を超える折れ ${kinked} 箇所（${((kinked / Math.max(joints, 1)) * 100).toFixed(0)}%）`,
)
