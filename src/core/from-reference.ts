import { buildFromComposition, type Piece } from './composition'
import type { LogoDesign, Shape, Step } from './dsl'
import { ladder } from './emblem'
import { limbs, packCircles, skeleton, tangentHull, type PackedCircle } from './pack'
import { getPaper, resetProject } from './paper-setup'
import {
  allocateArcs,
  fitToModule,
  harmonizeRadii,
  mirrorAxis,
  nestingDepth,
  sampleContoursFromSvg,
  smoothJoints,
  traceArcs,
} from './trace'

/**
 * 参照する形から「きっかけの点」だけを取り出し、順方向に作図する。
 *
 * 輪郭はなぞらない。取り出すのは内接円の中心と半径だけで、そこから先——
 * どの円を採るか、階梯のどの段へ寄せるか、対称にどう畳むか、どう肉付けするか
 * ——は作図としてこちら側で決める。
 *
 * 抽象度は「円の数」で決まる。少ないほど大づかみ、多いほど姿勢まで出る。
 * ロゴとして必要な抽象度は題材によって違うので、外から調整できる形にしてある。
 */

export type ReferenceOptions = {
  /** 取り出す円の数。抽象度そのもの（少ないほど大づかみ） */
  circles?: number
  /** 骨格を外接接線で包んでテーパーを出すか */
  taper?: boolean
  /** 下端を水平に切って接地させるか */
  ground?: boolean
  /**
   * 枝の付け根に彫る白い隙間の幅（基準半径に対する比）。
   * 0 で彫らない。付け根の推定が外れると胴を削るので、既定は 0。
   */
  channel?: number
  /** 継ぎ目の接線を揃えるか */
  smooth?: boolean
  /** 輪郭に使う円弧の総本数 */
  arcs?: number
  name?: string
  concept?: string
}

export type ReferenceResult = {
  design: LogoDesign
  /** 取り出した円（作図のきっかけ） */
  circles: PackedCircle[]
  /** 輪郭に使った円弧の本数 */
  arcs: number
  /** 異なる半径の種類数。体系に載っているかの指標 */
  radii: number
  symmetric: boolean
}

/** 参照 SVG からロゴを作図する */
export function designFromReference(
  svgText: string,
  options: ReferenceOptions = {},
): ReferenceResult | null {
  const count = Math.max(3, Math.min(options.circles ?? 9, 20))
  const traced = sampleContoursFromSvg(svgText)
  const scaled = fitToModule(traced.map((t) => t.points))
  if (scaled.length === 0) return null

  const contours = scaled.map((points, i) => ({ points, solid: traced[i].solid }))
  const circles = packCircles(contours, { count })
  if (circles.length === 0) return null

  // --- ここから順方向の作図 ---
  const base = circles[0].r
  // 参照が左右対称のときだけ、片側を捨てて反転で作る。非対称な形に対称性を
  // 強制すると蝶のような形になる
  const axis = mirrorAxis(scaled.flat())
  const symmetric = axis !== null
  const snapLadder = (r: number) => {
    const n = Math.round(Math.log(r / base) / Math.log(1.618))
    return ladder(base, 'golden', Math.max(-4, Math.min(2, n)))
  }

  const pieces: Piece[] = circles
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
        angle: 0,
        span: 180,
        thickness: 'regular' as const,
        mirror: symmetric && Math.abs(x) >= base * 0.12,
      }
    })

  const seed = buildFromComposition({
    name: options.name ?? 'mark',
    concept: options.concept ?? `参照から円 ${circles.length} 個を取り出して作図`,
    ratio: 'golden',
    pieces,
  } as never)

  const placed: PackedCircle[] = pieces.map((q) => ({ x: q.x, y: q.y, r: q.size }))
  const edges = skeleton(placed)

  const p = getPaper()
  resetProject()
  try {
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
        add(new p.Path.Circle(new p.Point(placed[i].x, placed[i].y), placed[i].r + grow))
      }
      if (options.taper !== false) {
        for (const [i, j] of edges) {
          if (!set.has(i) || !set.has(j)) continue
          const d = tangentHull(
            { ...placed[i], r: placed[i].r + grow },
            { ...placed[j], r: placed[j].r + grow },
          )
          if (d) add(new p.CompoundPath(d))
        }
      }
      return shape
    }

    let body = hullOf(placed.map((_, i) => i))
    if (!body) return null

    // 白の設計（カウンター）。枝を太らせた形から元を引くと縁取りの帯になり、
    // 付け根の近傍だけを残せば三日月の隙間になる
    const width = base * (options.channel ?? 0)
    if (width > 0) {
      const parentOf = new Map(edges.map(([child, parent]) => [child, parent]))
      for (const limb of limbs(placed, edges)) {
        const head = limb[0]
        if (placed[head].r < base * 0.25) continue
        const parent = parentOf.get(head)
        if (parent === undefined) continue
        const inner = hullOf(limb)
        const outer = hullOf(limb, width)
        if (!inner || !outer) continue
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
      }
    }

    // 接地。丸い脚が宙に浮いていると重さが出ない
    if (options.ground !== false) {
      const b = (body as paper.PathItem).bounds
      const blade = new p.Path.Rectangle(
        new p.Point(b.x - b.width, b.y + b.height - b.height * 0.035),
        new p.Size(b.width * 3, b.height),
      )
      const next: paper.PathItem = (body as paper.PathItem).subtract(blade)
      ;(body as paper.PathItem).remove()
      blade.remove()
      body = next
    }

    // 輪郭を円弧で描き直す。円板の合体は丸い凹凸の連なりにしかならない
    const outline = new p.CompoundPath((body as paper.PathItem).pathData)
    ;(body as paper.PathItem).remove()
    const kids = (outline.children?.length ? outline.children : [outline]) as paper.Path[]
    const areaOf = (x: paper.Path) => (x as unknown as { area: number }).area
    const biggest = kids.reduce((a, b) => (Math.abs(areaOf(b)) > Math.abs(areaOf(a)) ? b : a))
    const solidSign = Math.sign(areaOf(biggest))

    const rings: Array<{ points: { x: number; y: number }[]; solid: boolean }> = []
    for (const path of kids) {
      const area = areaOf(path)
      if (path.length <= 0 || area === 0) continue
      const n = Math.max(64, Math.round(480 * (path.length / biggest.length)))
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i < n; i++) {
        const pt = path.getPointAt((path.length * i) / n)
        if (pt) pts.push({ x: pt.x, y: pt.y })
      }
      if (pts.length >= 8) rings.push({ points: pts, solid: Math.sign(area) === solidSign })
    }
    outline.remove()

    const shells = rings.map((r) => r.points)
    const quota = allocateArcs(shells, options.arcs ?? Math.max(12, circles.length * 2))
    const depth = nestingDepth(shells)
    const shapes: Shape[] = []
    const steps: Step[] = []
    shells.forEach((points, i) => {
      const { segments: raw } = traceArcs(points, {
        maxArcs: quota[i],
        mirrorX: symmetric ? 0 : undefined,
      })
      const segments = options.smooth === false ? raw : smoothJoints(raw)
      if (segments.length < 3) return
      shapes.push({ kind: 'contour', id: `s${i}`, segments })
      steps.push({ op: rings[i].solid ? 'add' : 'sub', ref: `s${i}` })
    })
    if (shapes.length === 0) return null

    const contourShapes = shapes.filter((x) => x.kind === 'contour')
    const tuned = harmonizeRadii(contourShapes.map((x) => (x.kind === 'contour' ? x.segments : [])))
    contourShapes.forEach((x, i) => {
      if (x.kind === 'contour') x.segments = tuned.groups[i]
    })
    const order = shapes.map((_, i) => i).sort((a, b) => depth[a] - depth[b])
    const arcs = shapes.reduce((n, x) => n + (x.kind === 'contour' ? x.segments.length : 0), 0)

    return {
      design: {
        ...seed,
        shapes: [...seed.shapes, ...shapes],
        parts: [{ id: 'mark', steps: order.map((i) => steps[i]), fill: 'primary', mirror: 'none' }],
      },
      circles,
      arcs,
      radii: tuned.radii.length,
      symmetric,
    }
  } finally {
    resetProject()
  }
}
