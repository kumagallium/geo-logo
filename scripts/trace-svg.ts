/**
 * SVG のシルエットを円弧の列へ還元して、幾何ロゴとして描き直す。
 *
 *   pnpm tsx scripts/trace-svg.ts input.svg 出力名 [円弧の総本数]
 *
 * 円弧の本数が抽象度そのもの。多いとトレースした絵、少ないとロゴになる。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Shape, Step } from '../src/core/index.js'
import { compile } from '../src/core/index.js'
import { allocateArcs, fitToModule, sampleContoursFromSvg, traceArcs } from '../src/core/trace.js'

const [file, out = 'trace', arcs = '12'] = process.argv.slice(2)
const svg = readFileSync(file, 'utf8')

const contours = fitToModule(sampleContoursFromSvg(svg))
if (contours.length === 0) {
  console.error('輪郭を取得できませんでした')
  process.exit(1)
}

const shapes: Shape[] = []
const steps: Step[] = []
const budget = Number(arcs)

// 本数は大きさではなく曲がりの総量で配る。小さくても複雑な抜きが潰れないように
const quota = allocateArcs(contours, budget)

contours.forEach((points, i) => {
  const { segments } = traceArcs(points, { maxArcs: quota[i] })
  if (segments.length < 3) return
  const id = `c${i}`
  shapes.push({ kind: 'contour', id, segments })
  steps.push({ op: i === 0 ? 'add' : 'sub', ref: id })
})

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
console.log(`${out}: 輪郭 ${shapes.length}（外形1 + 抜き${shapes.length - 1}）/ 円弧 計${total} 本 / インク ${(result.built.inkRatio * 100).toFixed(0)}%`)
