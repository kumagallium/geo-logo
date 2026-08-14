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
  foldErr: (n: number) => number
  mirrorErr: number | null
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
  return err
}

/** 閾値を決め打たず、誤差そのものを返す。安定性は呼び出し側で見る。 */
function classifyFold(err: (n: number) => number, tol: number): number {
  for (const n of [6, 5, 4, 3, 2]) if (err(n) < tol) return n
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

  // 面積はシューレース。抜きは負で足す。絶対値で足すと穴が塗りとして
  // 数えられ、インク率が 0.9 まで跳ね上がる（実際に跳ね上がった）
  const area = traced.reduce((sum, t) => {
    let a = 0
    for (let i = 0; i < t.points.length; i++) {
      const p = t.points[i]
      const q = t.points[(i + 1) % t.points.length]
      a += p.x * q.y - q.x * p.y
    }
    return sum + (t.solid ? 1 : -1) * (Math.abs(a) / 2)
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
    foldErr: foldOrder(pts, cx, cy, R),
    // 判定の緩さを変えて、対称と見なされる割合がどう動くかを見る
    mirrorErr: mirrorAxis(pts, undefined, 0.02) !== null
      ? 0.02
      : mirrorAxis(pts, undefined, 0.05) !== null
        ? 0.05
        : mirrorAxis(pts, undefined, 0.1) !== null
          ? 0.1
          : null,
  })
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length
/** 四分位。中央値だけでは散らばりが見えない */
const quart = (xs: number[], digits = 0) => {
  const s = [...xs].sort((a, b) => a - b)
  const at = (q: number) => s[Math.floor(s.length * q)] ?? 0
  return `${at(0.25).toFixed(digits)}〜${at(0.75).toFixed(digits)}`
}

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
console.log(`  中央値 ${median(cs).toFixed(3)}  （四分位 ${quart(cs, 2)}）`)
// 分布の形を見る。中央値だけだと「環に並ぶ」のか「散らばる」のか分からない
const hist = new Array(10).fill(0)
for (const c of cs) hist[Math.min(9, Math.floor(c * 10))]++
for (let i = 0; i < 10; i++) {
  const pct = (hist[i] / cs.length) * 100
  console.log(
    `  ${(i / 10).toFixed(1)}〜${((i + 1) / 10).toFixed(1)}  ${'█'.repeat(Math.round(pct / 2)).padEnd(26)} ${pct.toFixed(1)}%`,
  )
}

console.log('\n■ 構成')
console.log(`  輪郭の数    中央値 ${median(samples.map((s) => s.contours))} 本  （四分位 ${quart(samples.map((s) => s.contours))}）`)
console.log(`  インク率    中央値 ${median(samples.map((s) => s.ink)).toFixed(2)}  （四分位 ${quart(samples.map((s) => s.ink), 2)}）`)
console.log('  ※ 半径の種類は畳み込み依存なので載せない')

console.log('\n■ 左右対称（判定の緩さ別）')
for (const tol of [0.02, 0.05, 0.1]) {
  const c = count(samples, (s) => s.mirrorErr !== null && s.mirrorErr <= tol)
  console.log(`  許容 ${(tol * 100).toFixed(0)}%: ${((c / samples.length) * 100).toFixed(0)}%（${c} 点）`)
}

console.log('\n■ 回転対称（判定の緩さ別）')
for (const tol of [0.02, 0.045, 0.08]) {
  const dist = new Map<number, number>()
  for (const s of samples) {
    const n = classifyFold(s.foldErr, tol)
    dist.set(n, (dist.get(n) ?? 0) + 1)
  }
  const parts = [...dist]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n === 1 ? 'なし' : `${n}回`} ${((c / samples.length) * 100).toFixed(0)}%`)
  console.log(`  許容 ${(tol * 100).toFixed(1)}%: ${parts.join(' / ')}`)
}
console.log('  → 割合が閾値で大きく動くなら、その数字は信用しない')
console.log(
  '  ただし閾値に強くても正しいとは限らない。この判定は 3 回対称を 0% と出すが、\n' +
    '  三つ巴・三つ葉葵のような 3 回対称の紋は実在する。外周の丸を持つ紋（丸に◯◯）で\n' +
    '  半径の輪郭がほぼ一定になり、どの n でも重なってしまうのが原因と見ている。\n' +
    '  外周を除いてから測り直すまで、この数字は使わないこと。',
)
