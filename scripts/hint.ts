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
import { limbs, packCircles, skeleton, tangentHull } from '../src/core/pack.js'
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

// 円板を union すると、大きさの違う 2 円は 2 つのコブになる。外接接線で
// 結ぶと円錐台になり、付け根から末端へ細くなる。太さが一定の管は風船に見える。
const p = getPaper()
resetProject()

const placed = pieces.map((q) => ({ x: q.x, y: q.y, r: q.size }))
const edges = skeleton(placed)

/** 円の集合を、外接接線で包んだひとつの形にする */
const hullOf = (index: number[], grow = 0): paper.PathItem | null => {
  let shape: paper.PathItem | null = null
  const add = (item: paper.PathItem) => {
    if (!shape) {
      shape = item
      return
    }
    const next: paper.PathItem = shape.unite(item)
    shape.remove()
    item.remove()
    shape = next
  }
  const set = new Set(index)
  for (const i of index) {
    const c = placed[i]
    add(new p.Path.Circle(new p.Point(c.x, c.y), c.r + grow))
  }
  for (const [i, j] of edges) {
    if (!set.has(i) || !set.has(j)) continue
    const d = tangentHull(
      { ...placed[i], r: placed[i].r + grow },
      { ...placed[j], r: placed[j].r + grow },
    )
    if (d) add(new p.CompoundPath(d))
  }
  return shape
}

let body = hullOf(placed.map((_, i) => i))
if (!body) {
  console.error('形を組み立てられませんでした')
  process.exit(1)
}

// --- 白の設計（カウンター）---
//
// 参照のマークは、腕と胴・腿と胴を白い隙間が彫り分けている。塗り残しでは
// なく、輪郭と同じ精度で設計された形。タイポグラフィでいうカウンターにあたる。
//
// 枝を一定量だけ太らせた形から元の形を引くと、枝を縁取る一定幅の帯になる。
// それをマークから引けば、枝が胴へ入るところに隙間が生まれる。枝は先へ
// いくほど細いので、帯も自然に細くなり、両端が尖る。
// 既定は 0（彫らない）。骨格から推定した付け根の位置が実際の関節と一致せず、
// 胴の真ん中を削ってしまう。概念は正しいが、付け根を当てる手段がまだ無い
const channelWidth = base * Number(process.env.GEOLOGO_CHANNEL ?? '0')
let channels = 0
const parentOf = new Map(edges.map(([child, parent]) => [child, parent]))

if (channelWidth > 0) {
  for (const limb of limbs(placed, edges)) {
    const head = limb[0]
    // 胴に対して小さすぎる枝は彫らない（線が潰れて汚れになる）
    if (placed[head].r < base * 0.25) continue
    const parent = parentOf.get(head)
    if (parent === undefined) continue

    const inner = hullOf(limb)
    const outer = hullOf(limb, channelWidth)
    if (!inner || !outer) continue

    // 帯を一周させると枝が胴から切り離される。参照の隙間は付け根まわりだけの
    // 三日月で、一周していない。親の円の近傍に限って彫る
    const near = new p.Path.Circle(
      new p.Point(placed[parent].x, placed[parent].y),
      placed[parent].r * 1.15,
    )
    const ring = outer.subtract(inner)
    const crescent = ring.intersect(near)
    const next: paper.PathItem = (body as paper.PathItem).subtract(crescent)
    ;(body as paper.PathItem).remove()
    for (const x of [inner, outer, ring, near, crescent]) x.remove()
    body = next
    channels++
  }
}

// --- 接地 ---
//
// 参照の足は地面に平らに接して重心が下にある。丸い脚が宙に浮いていると
// 重さが出ない。下端を水平に切って地面に載せる。
if (process.env.GEOLOGO_GROUND !== '0') {
  const b = (body as paper.PathItem).bounds
  const cut = b.height * 0.035
  const blade = new p.Path.Rectangle(
    new p.Point(b.x - b.width, b.y + b.height - cut),
    new p.Size(b.width * 3, b.height),
  )
  const next: paper.PathItem = (body as paper.PathItem).subtract(blade)
  ;(body as paper.PathItem).remove()
  blade.remove()
  body = next
}
const outline = new p.CompoundPath((body as paper.PathItem).pathData)
;(body as paper.PathItem).remove()
const kids = (outline.children?.length ? outline.children : [outline]) as paper.Path[]
const M = design.module

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
    if (pt) pts.push({ x: pt.x, y: pt.y })
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
    `異なる半径 ${tuned.radii.length} 種 / 白の隙間 ${channels} 本 / ` +
    `インク ${(result.built.inkRatio * 100).toFixed(0)}%`,
)
