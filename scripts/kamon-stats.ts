/**
 * 家紋から作図の定石を測る。
 *
 *   pnpm tsx scripts/kamon-stats.ts
 *
 * 作図側で使っている係数——比例の梯子、囲いの隙間、線の太さ、反復の配置、
 * インク率——は、どれもこちらが勘で決めた値だった。実物を測って置き換える。
 *
 * トレースは学習のためだけに使う。成果は数値の表として順方向へ戻すので、
 * 成果物に他人の図形は入らない。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mirrorAxis, sampleContoursFromSvg, traceArcs, type Vec } from '../src/core/trace.js'

const DIR = existsSync('data/kamon') ? 'data/kamon' : 'tmp'
const files = existsSync('data/kamon')
  ? readdirSync(DIR).filter((f) => f.endsWith('.svg'))
  : ['g1.svg', 'g2.svg', 'g3.svg', 'g4.svg', 'g5.svg', 'g6.svg']

type Sample = {
  radii: number[]
  centers: number[]
  distinct: number
  contours: number
  ink: number
  fold: number
  mirrored: boolean
}

/** n 回対称の次数。輪郭を重心まわりに回して、自分に重なる最小の n を探す。 */
function foldOrder(points: Vec[], cx: number, cy: number, R: number): number {
  const polar = points.map((p) => ({
    a: Math.atan2(p.y - cy, p.x - cx),
    r: Math.hypot(p.x - cx, p.y - cy) / R,
  }))
  // 角度をビンに落として半径の並びを作る。回転はビンの巡回シフトになる
  const B = 180
  const prof = new Array(B).fill(0)
  for (const q of polar) {
    const i = Math.floor((((q.a + Math.PI) / (2 * Math.PI)) * B) % B)
    prof[i] = Math.max(prof[i], q.r)
  }
  const err = (n: number) => {
    const shift = B / n
    if (!Number.isInteger(shift)) return Number.POSITIVE_INFINITY
    let sum = 0
    for (let i = 0; i < B; i++) sum += Math.abs(prof[i] - prof[(i + shift) % B])
    return sum / B
  }
  for (const n of [6, 5, 4, 3, 2]) if (err(n) < 0.045) return n
  return 1
}

const samples: Sample[] = []
for (const file of files) {
  let traced: ReturnType<typeof sampleContoursFromSvg>
  try {
    traced = sampleContoursFromSvg(readFileSync(`${DIR}/${file}`, 'utf8'), 240)
  } catch {
    continue
  }
  if (!traced?.length) continue
  const contours = traced.map((t) => t.points)
  const pts = contours.flat()
  const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2
  const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2
  const R = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)))
  if (!(R > 0)) continue

  const radii: number[] = []
  const centers: number[] = []
  for (const c of contours) {
    const { segments } = traceArcs(c, { toleranceRatio: 0.02 })
    let x = 0
    let y = 0
    for (const s of segments) {
      if (s.r === undefined || s.r <= 0) continue
      const ratio = s.r / R
      // ごく小さい弧は当てはめの揺れなので数えない
      if (ratio > 0.04 && ratio < 3) radii.push(ratio)
      x += s.x
      y += s.y
    }
    if (segments.length > 0) {
      centers.push(Math.hypot(x / segments.length - cx, y / segments.length - cy) / R)
    }
  }

  // 面積はシューレース。塗りと抜きの区別はここでは付けず、外接円との比を見る
  const area = contours.reduce((sum, c) => {
    let a = 0
    for (let i = 0; i < c.length; i++) {
      const p = c[i]
      const q = c[(i + 1) % c.length]
      a += p.x * q.y - q.x * p.y
    }
    return sum + Math.abs(a) / 2
  }, 0)

  const sorted = [...radii].sort((a, b) => a - b)
  let distinct = 0
  let last = -1
  for (const v of sorted) {
    if (last < 0 || (v - last) / last > 0.08) distinct++
    last = v
  }

  samples.push({
    radii,
    centers,
    distinct,
    contours: contours.length,
    ink: area / (Math.PI * R * R),
    fold: foldOrder(pts, cx, cy, R),
    mirrored: mirrorAxis(pts) !== null,
  })
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length

console.log(`家紋 ${samples.length} 点\n`)

// 畳み込みで山を数えると、隣り合う山の比は畳み込み閾値そのものになる。
// 実際 4% で 1.08、8% で 1.17、15% で 1.32、25% で 1.58 と、閾値に追随した。
// 一度これを「√2 の梯子」と読み違えたので、閾値に依らない検定を並べておく。
console.log('■ 半径の梯子（外接半径 = 1）※ 山の位置は畳み込み閾値に依存する。下の検定を見ること')
const all = samples.flatMap((s) => s.radii).sort((a, b) => a - b)
const bins: number[][] = []
for (const v of all) {
  const b = bins[bins.length - 1]
  const m = b ? b.reduce((a, x) => a + x, 0) / b.length : 0
  if (b && (v - m) / m <= 0.08) b.push(v)
  else bins.push([v])
}
const peaks = bins
  .filter((b) => b.length >= all.length / 60)
  .map((b) => b.reduce((a, x) => a + x, 0) / b.length)
  .sort((a, b) => b - a)
console.log(`  ${peaks.map((p) => p.toFixed(3)).join(' / ')}`)
const steps = peaks.slice(0, -1).map((p, i) => p / peaks[i + 1])
if (steps.length) {
  console.log(
    `  隣り合う比: ${steps.map((s) => s.toFixed(2)).join(' ')}  → 中央値 ${median(steps).toFixed(3)}`,
  )
  console.log(`  （√2 = 1.414 / φ = 1.618 / 3:2 = 1.5）`)
}

// 閾値に依らない検定。対数半径を固定幅で刻み、自己相関に周期が立つかを見る。
// 梯子があるなら log(比) の位置に山が出るはず。
{
  const LO = Math.log(0.05)
  const HI = Math.log(1.5)
  const B = 200
  const h = new Array(B).fill(0)
  for (const v of all) {
    if (v <= 0.05 || v >= 1.5) continue
    h[Math.min(B - 1, Math.floor(((Math.log(v) - LO) / (HI - LO)) * B))]++
  }
  const mean = h.reduce((a, b) => a + b, 0) / B
  const dev = h.map((x) => x - mean)
  const norm = dev.reduce((a, x) => a + x * x, 0) || 1
  const acf = (lag: number) => {
    let s = 0
    for (let i = 0; i + lag < B; i++) s += dev[i] * dev[i + lag]
    return s / norm
  }
  const bg: number[] = []
  for (let lag = 5; lag < 60; lag++) bg.push(acf(lag))
  bg.sort((a, b) => a - b)
  console.log('\n■ 梯子はあるか（対数半径の自己相関。畳み込みを使わない）')
  for (const r of [1.414, 1.5, 1.618]) {
    const v = acf(Math.round((Math.log(r) / (HI - LO)) * B))
    console.log(`  比 ${r.toFixed(3)}: ${v.toFixed(3)}`)
  }
  console.log(
    `  背景 lag 5〜59: 最小 ${bg[0].toFixed(3)} 中央 ${bg[Math.floor(bg.length / 2)].toFixed(3)} 最大 ${bg[bg.length - 1].toFixed(3)}`,
  )
  console.log('  → 背景に埋もれていれば、梯子は無い')
}

console.log('\n■ 要素の中心はどこにあるか（外接半径 = 1）')
const cs = samples.flatMap((s) => s.centers)
console.log(`  中心に置く（0.1 未満）: ${((count(cs, (c) => c < 0.1) / cs.length) * 100).toFixed(0)}%`)
console.log(`  中央値 ${median(cs).toFixed(3)}`)

console.log('\n■ 構成')
console.log(`  半径の種類  中央値 ${median(samples.map((s) => s.distinct))} 種`)
console.log(`  輪郭の数    中央値 ${median(samples.map((s) => s.contours))} 本`)
console.log(`  インク率    中央値 ${median(samples.map((s) => s.ink)).toFixed(2)}（外接円に対する塗り）`)

console.log('\n■ 対称')
console.log(`  左右対称    ${((count(samples, (s) => s.mirrored) / samples.length) * 100).toFixed(0)}%`)
for (const n of [2, 3, 4, 5, 6]) {
  const c = count(samples, (s) => s.fold === n)
  if (c > 0) console.log(`  ${n} 回対称    ${((c / samples.length) * 100).toFixed(0)}%（${c} 点）`)
}
const none = count(samples, (s) => s.fold === 1)
console.log(`  回転対称なし ${((none / samples.length) * 100).toFixed(0)}%（${none} 点）`)
