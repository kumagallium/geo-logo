/**
 * 参照する形から「きっかけの点」だけを取り出し、順方向に作図し直す。
 *
 *   pnpm tsx scripts/hint.ts reference.svg 出力名 [円の数]
 *
 * 輪郭はなぞらない。取り出すのは内接円の中心と半径だけで、そこから先は
 * 階梯へ寄せ、対称に畳んで作図する。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildFromComposition } from '../src/core/composition.js'
import { compile } from '../src/core/index.js'
import { packCircles } from '../src/core/pack.js'
import {
  allocateArcs,
  fitToModule,
  harmonizeRadii,
  mirrorAxis,
  nestingDepth,
  sampleContoursFromSvg,
  smoothJoints,
  traceArcs,
} from '../src/core/trace.js'
import { getPaper, resetProject } from '../src/core/paper-setup.js'
import type { Shape, Step } from '../src/core/index.js'
import { ladder } from '../src/core/emblem.js'

const [file, out = 'hint', n = '7'] = process.argv.slice(2)

const traced = sampleContoursFromSvg(readFileSync(file, 'utf8'))
const scaled = fitToModule(traced.map((t) => t.points))
const contours = scaled.map((points, i) => ({ points, solid: traced[i].solid }))

const circles = packCircles(contours, { count: Number(n) })
if (circles.length === 0) {
  console.error('円を取り出せませんでした')
  process.exit(1)
}

// ここから先が順方向の作図。
// 半径は階梯の段へ寄せ、対称軸があれば片側だけ残して反転させる。
const base = circles[0].r
// 参照が左右対称のときだけ、片側を捨てて反転で作る。
// 非対称な形（横向きの立ち姿など）に対称性を強制すると蝶のような形になる
const axis = mirrorAxis(scaled.flat())
const symmetric = axis !== null
const snapLadder = (r: number) => {
  const n = Math.round(Math.log(r / base) / Math.log(1.618))
  return ladder(base, 'golden', Math.max(-4, Math.min(2, n)))
}

const pieces = circles
  // 対称なら軸の片側だけ残し、残りは反転で作る
  .filter((c) => !symmetric || Math.abs(c.x - (axis as number)) < base * 0.12 || c.x >= (axis as number))
  .map((c) => {
    const x = symmetric ? c.x - (axis as number) : c.x
    return {
      label: '',
      form: 'disc' as const,
      role: 'add' as const,
      x: Math.round(x * 4) / 4,
      y: Math.round(c.y * 4) / 4,
      size: snapLadder(c.r),
      mirror: symmetric && Math.abs(x) >= base * 0.12,
    }
  })

const design = buildFromComposition({
  name: out,
  concept: `参照した形から内接円 ${circles.length} 個を取り出し、半径を黄金比の階梯へ寄せて対称に作図した`,
  ratio: 'golden',
  pieces,
} as never)

// 円板を合体させただけの輪郭は、丸い凹凸の連なりになる。円は構造を決める
// ためのもので、輪郭はそこから改めて円弧で描く。家紋の逆算で分かったこと。
const rough = compile(design)
const p = getPaper()
resetProject()
const outline = new p.CompoundPath(rough.built.parts.map((x) => x.pathData).join(' '))
const kids = (outline.children?.length ? outline.children : [outline]) as paper.Path[]
const M = rough.design.module

const smoothed: Array<{ points: { x: number; y: number }[]; solid: boolean }> = []
const biggest = kids.reduce((a, b) =>
  Math.abs((b as unknown as { area: number }).area) > Math.abs((a as unknown as { area: number }).area) ? b : a,
)
const solidSign = Math.sign((biggest as unknown as { area: number }).area)
for (const path of kids) {
  const area = (path as unknown as { area: number }).area
  if (path.length <= 0 || area === 0) continue
  const count = Math.max(64, Math.round(480 * (path.length / biggest.length)))
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) {
    const pt = path.getPointAt((path.length * i) / count)
    if (pt) pts.push({ x: pt.x / M, y: pt.y / M })
  }
  if (pts.length >= 8) smoothed.push({ points: pts, solid: Math.sign(area) === solidSign })
}
outline.remove()
resetProject()

const smoothContours = smoothed.map((c) => c.points)
const quota = allocateArcs(smoothContours, Math.max(12, circles.length * 2))
const depth = nestingDepth(smoothContours)
const shapes: Shape[] = []
const steps: Step[] = []
smoothContours.forEach((points, i) => {
  const { segments: raw } = traceArcs(points, {
    maxArcs: quota[i],
    mirrorX: symmetric ? 0 : undefined,
  })
  // 継ぎ目の接線を揃える。独立に当てはめた弧は継ぎ目で平均 45° 折れており、
  // 小さく見ると滑らかでも幾何としては角が並んでいる
  const segments = process.env.GEOLOGO_SMOOTH === '0' ? raw : smoothJoints(raw)
  if (segments.length < 3) return
  shapes.push({ kind: 'contour', id: `s${i}`, segments })
  steps.push({ op: smoothed[i].solid ? 'add' : 'sub', ref: `s${i}` })
})
const contourShapes = shapes.filter((x) => x.kind === 'contour')
const tuned = harmonizeRadii(contourShapes.map((x) => (x.kind === 'contour' ? x.segments : [])))
contourShapes.forEach((x, i) => {
  if (x.kind === 'contour') x.segments = tuned.groups[i]
})
const order = shapes.map((_, i) => i).sort((a, b) => depth[a] - depth[b])

const result = compile({
  ...design,
  concept: `${design.concept}。輪郭は円弧 ${shapes.reduce((n, x) => n + (x.kind === 'contour' ? x.segments.length : 0), 0)} 本で描き直した`,
  shapes: [...design.shapes, ...shapes],
  parts: [{ id: 'mark', steps: order.map((i) => steps[i]), fill: 'primary', mirror: 'none' }],
})
mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)
writeFileSync(`tmp/${out}-poster.svg`, result.posterSvg)

const arcs = shapes.reduce((n, x) => n + (x.kind === 'contour' ? x.segments.length : 0), 0)
console.log(
  `${out}: 円 ${circles.length} → 輪郭 ${shapes.length} / 円弧 ${arcs} 本 / ` +
    `異なる半径 ${tuned.radii.length} 種 / 対称 ${symmetric ? 'あり' : 'なし'} / ` +
    `インク ${(result.built.inkRatio * 100).toFixed(0)}%`,
)
