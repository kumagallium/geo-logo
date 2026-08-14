import type { BuildResult } from './build'
import type { LogoDesign } from './dsl'
import { getPaper, resetProject } from './paper-setup'
import { rasterizeGray } from './raster'

/**
 * 出来上がったマークを測る。
 *
 * 「洗練された作図に見えるか」は主観だが、そう見えるものが共通して持つ
 * 性質は測れる。家紋 390 点の計測（scripts/kamon-stats.ts）で分かったのは
 * 「寸法の種類が少ない」「対称である」の 2 つで、どちらもここに入っている。
 *
 * それだけでは足りないことも分かっている。寸法の種類が少なく対称な塊は、
 * ただの丸でも達成できるからだ。そこで articulation——輪郭が何回向きを
 * 変えるか——を corners として並べる。丸い団子は 0 になる。
 */

export type Metrics = {
  /** 作図線（シェイプ）の数 */
  shapes: number
  /** 完成形の輪郭の頂点数 */
  vertices: number
  /** そのうち 30° を超えて折れる頂点の数。丸い塊では 0 になる */
  corners: number
  /** 輪郭の本数（穴を含む） */
  contours: number
  /** 半径の種類。外接半径で正規化し 8% で畳む */
  radii: number
  /** 線幅の種類。同上 */
  strokes: number
  /** 塗り面積 / 外接矩形 */
  ink: number
  /** 左右対称度 0〜1。画素の鏡像一致で測る */
  mirror: number
}

/** 相対 8% で畳んだ種類数。kamon-stats の distinct と同じ規則。 */
export function distinctCount(values: number[], tolerance = 0.08): number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b)
  let n = 0
  let last = -1
  for (const v of sorted) {
    if (last < 0 || (v - last) / last > tolerance) n++
    last = v
  }
  return n
}

/** 設計に現れる半径をすべて集める（輪郭の弧の半径も含む） */
export function radiiOf(design: LogoDesign): number[] {
  const out: number[] = []
  for (const s of design.shapes) {
    if (s.kind === 'contour') {
      for (const seg of s.segments) if (seg.r) out.push(seg.r)
    } else if ('r' in s) {
      out.push(s.r)
    } else if (s.kind === 'rect') {
      out.push(Math.hypot(s.w, s.h) / 2)
    }
  }
  return out
}

/** 設計に現れる線幅をすべて集める */
export function strokesOf(design: LogoDesign): number[] {
  const out: number[] = []
  for (const s of design.shapes) if ('w' in s) out.push(s.w)
  return out
}

/** 折れ角がこれを超える頂点を「角」と数える（度） */
const CORNER_DEGREES = 30

type Shaped = { vertices: number; corners: number; contours: number }

/**
 * 完成形の輪郭を数える。
 *
 * 設計（円と直線）ではなくブーリアン後の実形を見る。円を 3 つ足しただけの
 * 塊でも、接合部には必ず角ができる。設計側の図形数を数えるとそれが見えない。
 */
function shapeOf(built: BuildResult, minLength: number): Shaped {
  const p = getPaper()
  resetProject()
  let vertices = 0
  let corners = 0
  let contours = 0
  try {
    const compound = new p.CompoundPath(built.parts.map((x) => x.pathData).join(' '))
    const paths = compound.children.length > 0 ? compound.children : [compound]
    for (const child of paths) {
      const curves = (child as InstanceType<PaperPath>).curves ?? []
      const n = curves.length
      if (n < 2) continue
      contours++
      for (let i = 0; i < n; i++) {
        const prev = curves[(i - 1 + n) % n]
        const cur = curves[i]
        // 微小な辺は当てはめの揺れ。ここを角と数えると数字が意味を失う
        if (prev.length < minLength || cur.length < minLength) continue
        vertices++
        const turn = Math.abs(prev.getTangentAtTime(1).getDirectedAngle(cur.getTangentAtTime(0)))
        if (turn > CORNER_DEGREES) corners++
      }
    }
    compound.remove()
  } finally {
    resetProject()
  }
  return { vertices, corners, contours }
}

// paper の型は CompoundPath#children を Item[] で返すので、Path のプロパティに
// 触るための最小の別名。paper 本体の型をそのまま使う。
type PaperPath = ReturnType<typeof getPaper>['Path']

/**
 * 左右対称度。
 *
 * 画素で測るのは、設計が対称でも演算の結果が非対称になりうるため
 * （囲いが片側だけ欠ける、といった破綻が実際に起きる）。
 */
export function mirrorScore(built: BuildResult, size = 128): number {
  const { gray } = rasterizeGray(built, { size })
  let total = 0
  let diff = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = (255 - gray[y * size + x]) / 255
      const b = (255 - gray[y * size + (size - 1 - x)]) / 255
      total += a
      diff += Math.abs(a - b)
    }
  }
  // 完全に非対称なら diff は total の 2 倍になる（各画素が両側で食い違う）
  return total > 0 ? Math.max(0, 1 - diff / (2 * total)) : 1
}

export function measure(design: LogoDesign, built: BuildResult): Metrics {
  const span = Math.max(built.artBounds.width, built.artBounds.height) || 1
  const { vertices, corners, contours } = shapeOf(built, span * 0.01)
  // 半径は外接半径で正規化する。家紋の計測と同じ土俵に乗せるため
  const norm = span / 2
  return {
    shapes: design.shapes.length,
    vertices,
    corners,
    contours,
    radii: distinctCount(radiiOf(design).map((r) => r / norm)),
    strokes: distinctCount(strokesOf(design).map((w) => w / norm)),
    ink: built.inkRatio,
    mirror: mirrorScore(built),
  }
}

/** 1 行の要約。前後比較を並べて読むための形。 */
export function formatMetrics(m: Metrics): string {
  return (
    `図形 ${String(m.shapes).padStart(3)} / 頂点 ${String(m.vertices).padStart(3)} / ` +
    `角 ${String(m.corners).padStart(3)} / 輪郭 ${String(m.contours).padStart(2)} / ` +
    `半径 ${m.radii} 種 / 線幅 ${m.strokes} 種 / ` +
    `インク ${(m.ink * 100).toFixed(0)}% / 対称 ${(m.mirror * 100).toFixed(0)}%`
  )
}
