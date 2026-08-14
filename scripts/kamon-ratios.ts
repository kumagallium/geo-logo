/**
 * 家紋から定石（半径の比）を測る。
 *
 *   pnpm tsx scripts/kamon-ratios.ts
 *
 * 作図側で使う比例の梯子（φ / √2 / 1.5）は、こちらが先に決めた値であって
 * 家紋が実際に使っている値ではない。外接半径で正規化した半径を数え上げ、
 * 繰り返し現れる比を取り出す。トレースは学習のためだけに使い、成果は
 * 「係数の表」として順方向へ戻す。
 */
import { readFileSync } from 'node:fs'
import { sampleContoursFromSvg, traceArcs } from '../src/core/trace.js'

import { existsSync, readdirSync } from 'node:fs'

// data/kamon が用意されていればそちらを使う（scripts/fetch-kamon.ts で取得）
const DIR = existsSync('data/kamon') ? 'data/kamon' : 'tmp'
const files = existsSync('data/kamon')
  ? readdirSync(DIR).filter((f) => f.endsWith('.svg')).map((f) => f.replace(/\.svg$/, ''))
  : ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']
const all: number[] = []

for (const f of files) {
  const svg = readFileSync(`${DIR}/${f}.svg`, 'utf8')
  const traced = sampleContoursFromSvg(svg, 240)
  if (!traced?.length) { console.log(`${f}: 輪郭なし`); continue }
  const contours = traced.map((t) => t.points)
  const pts = contours.flat()
  const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2
  const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2
  // 外接半径で正規化する。マークの大きさに依らない比を得るため
  const R = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)))

  const radii: number[] = []
  for (const c of contours) {
    const { segments } = traceArcs(c, { toleranceRatio: 0.02 })
    for (const s of segments) if (s.r !== undefined && s.r > 0) radii.push(s.r / R)
  }
  // 近い値を畳む
  const sorted = [...radii].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const v of sorted) {
    const g = groups[groups.length - 1]
    const mean = g ? g.reduce((a, b) => a + b, 0) / g.length : 0
    if (g && Math.abs(v - mean) / mean <= 0.08) g.push(v)
    else groups.push([v])
  }
  const reps = groups
    .filter((g) => g.length >= 2)
    .map((g) => g.reduce((a, b) => a + b, 0) / g.length)
    .filter((r) => r < 3)
  all.push(...reps)
  console.log(`${f}: 輪郭 ${contours.length} / 半径 ${reps.length} 種 = ${reps.map((r) => r.toFixed(3)).join(', ')}`)
}

// 全体の分布
const sorted = [...all].sort((a, b) => a - b)
const bins: number[][] = []
for (const v of sorted) {
  const b = bins[bins.length - 1]
  const mean = b ? b.reduce((a, x) => a + x, 0) / b.length : 0
  if (b && Math.abs(v - mean) / mean <= 0.1) b.push(v)
  else bins.push([v])
}
console.log('\n=== 全体で繰り返し現れる比（外接半径 = 1）')
for (const b of bins.filter((x) => x.length >= 3).sort((a, c) => c.length - a.length)) {
  const m = b.reduce((a, x) => a + x, 0) / b.length
  const known = [
    ['1', 1], ['1/φ=0.618', 0.618], ['1/√2=0.707', 0.707], ['2/3', 0.667],
    ['1/2', 0.5], ['1/φ²=0.382', 0.382], ['1/3', 0.333], ['1/4', 0.25],
    ['1/5', 0.2], ['1/6', 0.167], ['1/8', 0.125],
  ] as const
  const near = known.reduce((best, k) => (Math.abs(k[1] - m) < Math.abs(best[1] - m) ? k : best))
  const off = ((Math.abs(near[1] - m) / m) * 100).toFixed(0)
  console.log(`  ${m.toFixed(3)}  (${b.length} 本)  ≈ ${near[0]}  ずれ ${off}%`)
}
