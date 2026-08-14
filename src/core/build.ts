// paper.d.ts はグローバルに `declare namespace paper` を置くため、型は import 不要
import type { LogoDesign, Shape, Step } from './dsl'
import { getPaper, resetProject, type PaperCore } from './paper-setup'

export type Bounds = { x: number; y: number; width: number; height: number }

export type BuiltPart = {
  id: string
  fill: string
  /** px 単位のパスデータ */
  pathData: string
}

/** 設計図に描くための作図線（すべて px 単位） */
export type ConstructionItem =
  | { kind: 'circle'; id: string; cx: number; cy: number; r: number }
  | { kind: 'line'; id: string; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rect'; id: string; cx: number; cy: number; w: number; h: number; rotate: number }
  | { kind: 'point'; id: string; x: number; y: number }

export type BuildResult = {
  parts: BuiltPart[]
  construction: ConstructionItem[]
  /** 作図線を含む全体の枠（設計図用） */
  bounds: Bounds
  /** 塗り形状だけの枠（完成ロゴ用） */
  artBounds: Bounds
  /**
   * 結果が単一のプリミティブと区別できない形に潰れた場合、その id。
   *
   * 複数のシェイプを宣言したのに intersect / add の順序を誤ると、全体が
   * 基準円そのものに戻ることがある。幾何としては正常（面積も縦横比も妥当）
   * なので他の判定を素通りするが、ロゴとしては完全な失敗。
   */
  collapsedTo: string | null
  warnings: string[]
}

const EMPTY_BOUNDS: Bounds = { x: -1, y: -1, width: 2, height: 2 }

/**
 * 面積を取る。paper の型は `area` を Path / CompoundPath 側にしか宣言しておらず、
 * ブーリアン演算の戻り値である PathItem からは見えない（実行時には両方に在る）。
 */
function areaOf(item: paper.PathItem): number {
  return Math.abs((item as unknown as { area?: number }).area ?? 0)
}

export function build(design: LogoDesign): BuildResult {
  const p = getPaper()
  resetProject()

  const warnings: string[] = []
  const M = design.module
  const origin = new p.Point(0, 0)

  const shapeById = new Map<string, Shape>()
  for (const s of design.shapes) shapeById.set(s.id, s)

  // --- プリミティブ生成（モジュール単位のまま作る）---
  const primitives = new Map<string, paper.PathItem>()
  for (const s of design.shapes) {
    const item = makePrimitive(p, s)
    if (item) primitives.set(s.id, item)
    else warnings.push(`${s.id}: プリミティブを生成できなかった`)
  }

  // --- group を解決（1 段のみ・シェイプのみ参照可）---
  const groups = new Map<string, paper.PathItem>()
  for (const g of design.groups) {
    const item = foldSteps(g.steps, (ref) => primitives.get(ref) ?? null, warnings, `group ${g.id}`)
    if (item) groups.set(g.id, item)
  }

  const resolve = (ref: string): paper.PathItem | null =>
    groups.get(ref) ?? primitives.get(ref) ?? null

  // --- part を組み立て ---
  const parts: BuiltPart[] = []
  // 潰れ検出のため、px 換算前（モジュール単位）の形をそのまま控えておく。
  // 面積や外形寸法だけでは足りず（切り欠きと追加が相殺して一致しうる）、
  // 対称差で形そのものを比べる必要がある。
  const partShapes: paper.PathItem[] = []
  for (const part of design.parts) {
    let item = foldSteps(part.steps, resolve, warnings, `part ${part.id}`)
    if (!item) {
      warnings.push(`part ${part.id}: 結果が空になった`)
      continue
    }

    if (part.mirror !== 'none') {
      const mirrored = item.clone()
      if (part.mirror === 'vertical') mirrored.scale(-1, 1, origin)
      else mirrored.scale(1, -1, origin)
      const united = item.unite(mirrored)
      item.remove()
      mirrored.remove()
      item = united
    }

    partShapes.push(item.clone())

    // ここで初めて px へ。以降のストローク幅は px 絶対値で扱える。
    item.scale(M, origin)

    const pathData = item.pathData
    if (!pathData) {
      warnings.push(`part ${part.id}: パスが空`)
      item.remove()
      continue
    }
    parts.push({ id: part.id, fill: design.palette[part.fill], pathData })
    item.remove()
  }

  const construction = buildConstruction(design, M)
  const artBounds = computeBounds(p, parts, [])
  const bounds = computeBounds(p, parts, construction)
  const collapsedTo = findCollapse(p, design, partShapes)
  for (const shape of partShapes) shape.remove()

  resetProject()
  return { parts, construction, bounds, artBounds, collapsedTo, warnings }
}

/**
 * 完成形が単一のプリミティブと同じ形になっていないか調べる。
 *
 * 面積と外形寸法の比較では足りない。例えばリングから扇形を切り欠いて横棒を足すと、
 * 面積も外形もほぼ元のリングと一致してしまう（Monogram G のサンプルが実際にそうなる）。
 * そこで対称差 (A-B) ∪ (B-A) の面積を測り、元の面積に対して無視できるときだけ
 * 「同じ形」と判定する。
 */
function findCollapse(
  p: PaperCore,
  design: LogoDesign,
  partShapes: paper.PathItem[],
): string | null {
  if (partShapes.length !== 1 || design.shapes.length < 2) return null
  const result = partShapes[0]
  const resultArea = areaOf(result)
  if (resultArea < 1e-9) return null

  for (const shape of design.shapes) {
    const primitive = makePrimitive(p, shape)
    if (!primitive) continue
    const primitiveArea = areaOf(primitive)
    if (primitiveArea < 1e-9) {
      primitive.remove()
      continue
    }

    const onlyResult = result.subtract(primitive)
    const onlyPrimitive = primitive.subtract(result)
    const difference = areaOf(onlyResult) + areaOf(onlyPrimitive)
    onlyResult.remove()
    onlyPrimitive.remove()
    primitive.remove()

    if (difference / Math.max(resultArea, primitiveArea) < 0.01) return shape.id
  }
  return null
}

function foldSteps(
  steps: Step[],
  resolve: (ref: string) => paper.PathItem | null,
  warnings: string[],
  ctx: string,
): paper.PathItem | null {
  let acc: paper.PathItem | null = null

  for (const step of steps) {
    const source = resolve(step.ref)
    if (!source) {
      warnings.push(`${ctx}: 参照 "${step.ref}" を解決できない`)
      continue
    }
    const operand = source.clone()

    if (!acc) {
      if (step.op !== 'add') {
        warnings.push(`${ctx}: 最初のステップが ${step.op} なので add として扱った`)
      }
      acc = operand
      continue
    }

    let next: paper.PathItem
    switch (step.op) {
      case 'add':
        next = acc.unite(operand)
        break
      case 'sub':
        next = acc.subtract(operand)
        break
      case 'intersect':
        next = acc.intersect(operand)
        break
    }
    acc.remove()
    operand.remove()
    acc = next
  }

  if (acc && !acc.pathData) {
    acc.remove()
    return null
  }
  return acc
}

function makePrimitive(p: PaperCore, s: Shape): paper.PathItem | null {
  switch (s.kind) {
    case 'circle':
      return new p.Path.Circle(new p.Point(s.cx, s.cy), s.r)

    case 'ring': {
      const outer = new p.Path.Circle(new p.Point(s.cx, s.cy), s.r)
      const inner = new p.Path.Circle(new p.Point(s.cx, s.cy), Math.max(s.r - s.w, 1e-4))
      const result = outer.subtract(inner)
      outer.remove()
      inner.remove()
      return result
    }

    case 'bar': {
      const a = new p.Point(s.x1, s.y1)
      const b = new p.Point(s.x2, s.y2)
      const len = a.getDistance(b)
      if (len < 1e-9) return null
      const dir = b.subtract(a).divide(len)
      const normal = new p.Point(-dir.y, dir.x).multiply(s.w / 2)

      const body: paper.PathItem = new p.Path([
        a.add(normal),
        b.add(normal),
        b.subtract(normal),
        a.subtract(normal),
      ])
      ;(body as paper.Path).closed = true

      if (s.cap !== 'round') return body

      const capA = new p.Path.Circle(a, s.w / 2)
      const capB = new p.Path.Circle(b, s.w / 2)
      const withA = body.unite(capA)
      const result = withA.unite(capB)
      body.remove()
      capA.remove()
      capB.remove()
      withA.remove()
      return result
    }

    case 'rect': {
      const center = new p.Point(s.cx, s.cy)
      const size = new p.Size(s.w, s.h)
      const rect = new p.Rectangle(new p.Point(s.cx - s.w / 2, s.cy - s.h / 2), size)
      const item =
        s.radius && s.radius > 0
          ? new p.Path.Rectangle(rect, new p.Size(s.radius, s.radius))
          : new p.Path.Rectangle(rect)
      if (s.rotate) item.rotate(s.rotate, center)
      return item
    }

    case 'wedge': {
      const center = new p.Point(s.cx, s.cy)
      const a0 = (s.a0 * Math.PI) / 180
      const a1 = (s.a1 * Math.PI) / 180
      const span = a1 - a0
      if (Math.abs(span) < 1e-9) return null
      if (Math.abs(span) >= Math.PI * 2 - 1e-9) {
        return new p.Path.Circle(center, s.r)
      }

      const at = (angle: number) =>
        center.add(new p.Point(Math.cos(angle) * s.r, Math.sin(angle) * s.r))

      const path = new p.Path()
      path.moveTo(center)
      path.lineTo(at(a0))
      // 180°超は 1 本の arcTo で表せないため中間点で分割する
      const segments = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI * 0.75)))
      for (let i = 0; i < segments; i++) {
        const from = a0 + (span * i) / segments
        const to = a0 + (span * (i + 1)) / segments
        path.arcTo(at((from + to) / 2), at(to))
      }
      path.closePath()
      return path
    }

    case 'poly': {
      const path = new p.Path(s.points.map((pt) => new p.Point(pt.x, pt.y)))
      path.closed = true
      return path
    }
  }
}

/** 設計図に描く作図線を px 単位で組み立てる */
function buildConstruction(design: LogoDesign, M: number): ConstructionItem[] {
  const out: ConstructionItem[] = []
  for (const s of design.shapes) {
    switch (s.kind) {
      case 'circle':
      case 'wedge':
        out.push({ kind: 'circle', id: s.id, cx: s.cx * M, cy: s.cy * M, r: s.r * M })
        out.push({ kind: 'point', id: s.id, x: s.cx * M, y: s.cy * M })
        break
      case 'ring':
        out.push({ kind: 'circle', id: s.id, cx: s.cx * M, cy: s.cy * M, r: s.r * M })
        out.push({
          kind: 'circle',
          id: `${s.id}i`,
          cx: s.cx * M,
          cy: s.cy * M,
          r: (s.r - s.w) * M,
        })
        out.push({ kind: 'point', id: s.id, x: s.cx * M, y: s.cy * M })
        break
      case 'bar':
        out.push({
          kind: 'line',
          id: s.id,
          x1: s.x1 * M,
          y1: s.y1 * M,
          x2: s.x2 * M,
          y2: s.y2 * M,
        })
        break
      case 'rect':
        out.push({
          kind: 'rect',
          id: s.id,
          cx: s.cx * M,
          cy: s.cy * M,
          w: s.w * M,
          h: s.h * M,
          rotate: s.rotate ?? 0,
        })
        out.push({ kind: 'point', id: s.id, x: s.cx * M, y: s.cy * M })
        break
      case 'poly':
        for (let i = 0; i < s.points.length; i++) {
          const a = s.points[i]
          const b = s.points[(i + 1) % s.points.length]
          out.push({
            kind: 'line',
            id: `${s.id}-${i}`,
            x1: a.x * M,
            y1: a.y * M,
            x2: b.x * M,
            y2: b.y * M,
          })
        }
        break
    }
  }
  return out
}

function computeBounds(
  p: PaperCore,
  parts: BuiltPart[],
  construction: ConstructionItem[],
): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const absorb = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  for (const part of parts) {
    const probe = new p.CompoundPath(part.pathData)
    const b = probe.bounds
    absorb(b.left, b.top)
    absorb(b.right, b.bottom)
    probe.remove()
  }

  for (const c of construction) {
    switch (c.kind) {
      case 'circle':
        absorb(c.cx - c.r, c.cy - c.r)
        absorb(c.cx + c.r, c.cy + c.r)
        break
      case 'line':
        absorb(c.x1, c.y1)
        absorb(c.x2, c.y2)
        break
      case 'rect': {
        const d = Math.hypot(c.w, c.h) / 2
        absorb(c.cx - d, c.cy - d)
        absorb(c.cx + d, c.cy + d)
        break
      }
      case 'point':
        absorb(c.x, c.y)
        break
    }
  }

  if (!Number.isFinite(minX)) return EMPTY_BOUNDS
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
