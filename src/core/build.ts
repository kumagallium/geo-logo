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
  /**
   * インク比率 = 塗り面積 / 外接矩形の面積。
   *
   * ロゴが小さいサイズで成立するかの古典的な指標。極端に低いと
   * 「線が細く、大半が空白」のマークになり、16px では消える。
   * 逆に極端に高いと、ただの塗りつぶし図形になる。
   */
  inkRatio: number
  /**
   * 最も細い線の太さ / マークの短辺。
   * 1/25 を下回ると小サイズで線が飛ぶ（印刷・ファビコンで破綻する）。
   */
  minStrokeRatio: number | null
  /**
   * どのシェイプとも関係を持たない孤立シェイプの id。
   *
   * 古典的な幾何ロゴは「重なる / 接する / 同心 / 整列」のいずれかで
   * 全要素が結ばれている。関係の無い要素が離れて置かれると、個々が綺麗でも
   * 「部品が散らばった絵」になる。
   *
   * 判定は「実際に重なっている」か「constraints で関係が宣言されている」か。
   * 同心の帯（重ならないが正しい構成）を誤検出しないよう、宣言も辺として数える。
   */
  unrelated: string[]
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

/**
 * ブーリアン演算の結果をパスデータ経由で作り直す。
 *
 * paper.js は unite を重ねた CompoundPath の内部構造が不整合になることがあり、
 * その図形をさらにブーリアン演算へ渡すと **結果が黙って空になる**。
 * 実測: 丸キャップ付きの円弧（band ∩ wedge に cap 円を 2 回 unite したもの）を
 * ヴェシカと unite すると面積 0 になった。reorient() では直らず、
 * パスデータから作り直すと解消する。
 *
 * プリミティブ生成の中で合成を行うもの（ring / round cap の bar / arc）に適用する。
 */
function rebuild(p: PaperCore, item: paper.PathItem): paper.PathItem {
  const data = item.pathData
  item.remove()
  return data ? new p.CompoundPath(data) : new p.Path()
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
  const unrelated = findUnrelatedShapes(design, primitives)

  // インク比率と最細線は、px 換算前（モジュール単位）で測る
  const inkArea = partShapes.reduce((sum, s) => sum + areaOf(s), 0)
  const artW = artBounds.width / M
  const artH = artBounds.height / M
  const inkRatio = artW > 0 && artH > 0 ? inkArea / (artW * artH) : 0

  const strokeWidths = design.shapes
    .filter((s): s is Extract<Shape, { w: number }> => 'w' in s && s.kind !== 'rect')
    .map((s) => s.w)
  const shortSide = Math.min(artW, artH)
  const minStrokeRatio =
    strokeWidths.length > 0 && shortSide > 0 ? Math.min(...strokeWidths) / shortSide : null

  for (const shape of partShapes) shape.remove()

  resetProject()
  return {
    parts,
    construction,
    bounds,
    artBounds,
    collapsedTo,
    inkRatio,
    minStrokeRatio,
    unrelated,
    warnings,
  }
}

/**
 * 全要素が幾何学的な関係で結ばれているかを調べ、孤立したものを返す。
 *
 * 辺の条件は 2 つ:
 *   - 実際に重なっている（intersect の面積 > 0）
 *   - constraints で関係が宣言されている（tangent / concentric / align / onCircle）
 *
 * 接しているだけの円は交差面積が 0 になるため、幾何だけでは辺が張れない。
 * 良い設計はそれを constraints で宣言しているので、宣言も辺として数える。
 * これは同時に「関係は宣言せよ」という設計規律を促すことにもなる。
 */
function findUnrelatedShapes(
  design: LogoDesign,
  primitives: Map<string, paper.PathItem>,
): string[] {
  // 実際に使われているシェイプだけを対象にする
  const used = new Set<string>()
  for (const g of design.groups) for (const s of g.steps) used.add(s.ref)
  for (const part of design.parts) for (const s of part.steps) used.add(s.ref)
  const ids = design.shapes.map((s) => s.id).filter((id) => used.has(id) && primitives.has(id))

  // 総当たりのブーリアンは重い。実用域を超える構成では判定を諦める。
  if (ids.length < 2 || ids.length > 20) return []

  const parent = new Map(ids.map((id) => [id, id]))
  const find = (a: string): string => {
    let root = a
    while (parent.get(root) !== root) root = parent.get(root)!
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (find(ids[i]) === find(ids[j])) continue
      const a = primitives.get(ids[i])!.clone()
      const b = primitives.get(ids[j])!.clone()
      const overlap = a.intersect(b)
      const hit = areaOf(overlap) > 1e-6
      overlap.remove()
      a.remove()
      b.remove()
      if (hit) union(ids[i], ids[j])
    }
  }

  for (const c of design.constraints) {
    const members = c.type === 'align' ? c.ids : c.type === 'onCircle' ? [c.point, c.circle] : [c.a, c.b]
    const present = members.filter((m) => parent.has(m))
    for (let i = 1; i < present.length; i++) union(present[0], present[i])
  }

  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const root = find(id)
    groups.set(root, [...(groups.get(root) ?? []), id])
  }
  if (groups.size <= 1) return []

  // 最大の塊を「本体」とみなし、それ以外を孤立として返す
  const clusters = [...groups.values()].sort((a, b) => b.length - a.length)
  return clusters.slice(1).flat()
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
      return rebuild(p, result)
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

      // キャップ円は帯の内外エッジにちょうど接する退化配置になり、
      // ブーリアン演算が不安定になる（実測: w=0.4 で空、0.5 では正常という
      // 不規則な失敗）。1% だけ大きくして「接触」を「重なり」に変える。
      // 見た目の差は線幅の 1% なので識別できない。
      const capR = (s.w / 2) * 1.02
      const capA = new p.Path.Circle(a, capR)
      const capB = new p.Path.Circle(b, capR)
      const withA = body.unite(capA)
      const result = withA.unite(capB)
      body.remove()
      capA.remove()
      capB.remove()
      withA.remove()
      return rebuild(p, result)
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

    case 'arc': {
      // 円弧の帯 = 環（外半径 r+w/2、内半径 r-w/2）∩ 扇形。
      // ring と wedge の合成でも書けるが、円弧は幾何ロゴの主役なので
      // 1 プリミティブとして提供する。DSL 上のコストが直線と同じでないと、
      // モデルは常に直線を選んでしまう。
      const center = new p.Point(s.cx, s.cy)
      const outerR = s.r + s.w / 2
      const innerR = Math.max(s.r - s.w / 2, 1e-4)

      const outer = new p.Path.Circle(center, outerR)
      const inner = new p.Path.Circle(center, innerR)
      const band = outer.subtract(inner)
      outer.remove()
      inner.remove()

      const span = ((s.a1 - s.a0) * Math.PI) / 180
      if (Math.abs(span) >= Math.PI * 2 - 1e-9) return rebuild(p, band)

      const sector = makePrimitive(p, {
        kind: 'wedge',
        id: `${s.id}__sector`,
        cx: s.cx,
        cy: s.cy,
        // 扇形は帯を確実に覆う必要があるので外半径より大きく取る
        r: outerR * 1.5,
        a0: s.a0,
        a1: s.a1,
      })
      if (!sector) {
        band.remove()
        return null
      }
      const clipped = band.intersect(sector)
      band.remove()
      sector.remove()

      if (s.cap !== 'round') return rebuild(p, clipped)

      const at = (deg: number) => {
        const rad = (deg * Math.PI) / 180
        return center.add(new p.Point(Math.cos(rad) * s.r, Math.sin(rad) * s.r))
      }
      // キャップ円は帯の内外エッジにちょうど接する退化配置になり、
      // ブーリアン演算が不安定になる（実測: w=0.4 で空、0.5 では正常という
      // 不規則な失敗）。1% だけ大きくして「接触」を「重なり」に変える。
      // 見た目の差は線幅の 1% なので識別できない。
      const capR = (s.w / 2) * 1.02
      const capA = new p.Path.Circle(at(s.a0), capR)
      const capB = new p.Path.Circle(at(s.a1), capR)
      const withA = clipped.unite(capA)
      const result = withA.unite(capB)
      clipped.remove()
      capA.remove()
      capB.remove()
      withA.remove()
      return rebuild(p, result)
    }

    case 'poly': {
      const path = new p.Path(s.points.map((pt) => new p.Point(pt.x, pt.y)))
      path.closed = true
      return path
    }

    case 'contour': {
      // SVG のパスデータを組み立てて paper に読ませる。円弧は A コマンドで
      // 表すのが最も素直で、paper 側の arcTo（通過点指定）より誤差が出ない。
      const [first, ...rest] = s.segments
      const d = [`M ${first.x} ${first.y}`]
      for (const seg of rest) {
        d.push(arcCommand(seg))
      }
      d.push(arcCommand(first), 'Z')
      return new p.Path(d.join(' '))
    }
  }
}

/**
 * 円弧の端点・半径・回り方から、元の円の中心を求める。
 *
 * SVG の弧は端点指定なので中心を持たない。設計図に作図円を描くには
 * 逆算が要る。large-arc は常に 0 なので、解は 2 つのうち sweep で決まる方。
 */
function arcCenter(
  from: { x: number; y: number },
  seg: { x: number; y: number; r?: number; sweep: boolean },
): { x: number; y: number; r: number } | null {
  if (seg.r === undefined) return null
  const dx = seg.x - from.x
  const dy = seg.y - from.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return null

  // 半径が弦の半分に満たないときは弧が張れない。SVG と同じく半径を広げる
  const r = Math.max(seg.r, d / 2)
  const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0))
  const mx = (from.x + seg.x) / 2
  const my = (from.y + seg.y) / 2
  // 弦に直交する単位ベクトル
  const nx = -dy / d
  const ny = dx / d
  const sign = seg.sweep ? 1 : -1
  return { x: mx + sign * h * nx, y: my + sign * h * ny, r }
}

/** contour の 1 セグメントを SVG のパスコマンドにする */
function arcCommand(seg: { x: number; y: number; r?: number; sweep: boolean }): string {
  if (seg.r === undefined) return `L ${seg.x} ${seg.y}`
  // large-arc は常に 0。輪郭を 180 度を超える弧 1 本で繋ぐと、始点と終点の
  // 位置だけでは形が一意に決まらず、意図しない側へ回り込む。
  return `A ${seg.r} ${seg.r} 0 0 ${seg.sweep ? 1 : 0} ${seg.x} ${seg.y}`
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
      case 'arc': {
        // 設計図には中心線の円と、両端を切る半径線を描く（実際の作図と同じ）
        out.push({ kind: 'circle', id: s.id, cx: s.cx * M, cy: s.cy * M, r: s.r * M })
        out.push({ kind: 'point', id: s.id, x: s.cx * M, y: s.cy * M })
        const reach = (s.r + s.w) * M
        for (const [i, deg] of [s.a0, s.a1].entries()) {
          const rad = (deg * Math.PI) / 180
          out.push({
            kind: 'line',
            id: `${s.id}-r${i}`,
            x1: s.cx * M,
            y1: s.cy * M,
            x2: s.cx * M + Math.cos(rad) * reach,
            y2: s.cy * M + Math.sin(rad) * reach,
          })
        }
        break
      }
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
      case 'contour': {
        // 輪郭を構成する各円弧の「元になった円」を描く。これが作図の証拠で、
        // これが無いと設計図がただの外形線になり、作図した痕跡が残らない。
        //
        // 線は輪郭の大きさに合わせて延長する。半径ぶんで止めると輪郭の際に
        // 短い線が密集するだけで、毛羽立って見える。作図線は紙面を横切って
        // 初めて作図に見える。
        const xs = s.segments.map((g) => g.x)
        const ys = s.segments.map((g) => g.y)
        const reach =
          (Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2) *
          1.15

        /** a から b の向きへ、中心を挟んで両側に伸ばした線 */
        const through = (
          id: string,
          a: { x: number; y: number },
          b: { x: number; y: number },
        ) => {
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len = Math.hypot(dx, dy)
          if (len < 1e-9) return
          const ux = (dx / len) * reach
          const uy = (dy / len) * reach
          out.push({
            kind: 'line',
            id,
            x1: (a.x - ux) * M,
            y1: (a.y - uy) * M,
            x2: (a.x + ux) * M,
            y2: (a.y + uy) * M,
          })
        }

        // 同じ円を何度も描かない。円弧は 180 度を超えられないので 1 つの円が
        // 複数の弧に割れ、素朴に描くと同じ円が重なって線が数倍になる
        // （実測: 26 要素の輪郭に作図線 122 本）
        const drawn = new Set<string>()

        for (let i = 0; i < s.segments.length; i++) {
          const from = s.segments[(i - 1 + s.segments.length) % s.segments.length]
          const seg = s.segments[i]
          if (seg.r === undefined) {
            out.push({
              kind: 'line',
              id: `${s.id}-${i}`,
              x1: from.x * M,
              y1: from.y * M,
              x2: seg.x * M,
              y2: seg.y * M,
            })
            continue
          }
          const c = arcCenter(from, seg)
          if (!c) continue

          const key = `${Math.round(c.x * 40)}:${Math.round(c.y * 40)}:${Math.round(c.r * 40)}`
          if (!drawn.has(key)) {
            drawn.add(key)
            out.push({ kind: 'circle', id: `${s.id}-${i}`, cx: c.x * M, cy: c.y * M, r: c.r * M })
            out.push({ kind: 'point', id: `${s.id}-${i}c`, x: c.x * M, y: c.y * M })
          }
          // 中心から弧の終点へ通す線（延長した直径）と、端点どうしを結ぶ弦。
          // 始点への線は 1 つ前の弧の終点と同じなので引かない
          through(`${s.id}-${i}r1`, c, seg)
          out.push({
            kind: 'line',
            id: `${s.id}-${i}k`,
            x1: from.x * M,
            y1: from.y * M,
            x2: seg.x * M,
            y2: seg.y * M,
          })
        }
        break
      }

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
