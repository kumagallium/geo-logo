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
  /**
   * 塗り面積 / 墨の凸包。えぐれの深さ。
   *
   * 「ぼてっとして見える」を数にしたもの。角（corners）は輪郭が何回折れるかを
   * 数えるが、**浅い折れをいくら並べても塊は塊のまま**で、丸い団子と articulate
   * したマークの区別が付かない。凸包との差は「どれだけ食い込んでいるか」を見る
   * ので、塊かどうかが直接出る。
   *
   * 実測（samples/）: 縄 26% / ペガサス 44% / ジャッカル（輪郭）55% に対し、
   * 熊 76% / 魚 81% / クローバー 84%。後者が「ぼてっと」と読まれる側。
   */
  solidity: number
  /** 左右対称度 0〜1。画素の鏡像一致で測る */
  mirror: number
  /** 離れている墨の塊の面積比（大きい順）。1 要素なら 1 つながり */
  islands: number[]
  /** 白に囲まれた墨の数（瞳・覗き）。多いほど白が設計されている */
  nests: number
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

/**
 * 墨の塊を、離れている単位に分けて面積比を返す（大きい順）。
 *
 * 「浮いた部品」は目で見て最も分かりやすい破綻なのに、機械判定が無かった。
 * 設計側の `constraints` を見る判定（build.ts の unrelated）は、関係が宣言
 * されていれば通してしまう。関係が宣言されていても、外接で 1 点しか触れて
 * いなければ、目には別の物体に見える。
 *
 * ベクタの連結性ではなく画素で見るのはそのため。**見えているとおりに数える。**
 *
 * 4 近傍にするのは、斜めにしか触れていない画素を繋げないため。円どうしの
 * 外接は接点を通る行で横に隣り合うので繋がる（実測でそうなった）。一方、
 * 弧や棒の端が斜めに触れているだけのものは分かれる。
 *
 * 解像度の依存も測ってある。96 / 192 / 384 / 768 px で数えると、1% 以上の島は
 * どの解像度でも同じ数になり、1% 未満の島だけが解像度に追随して増えた
 *（ある生成物で 2 → 5 → 5 → 9）。毛ほどの幅のくびれで、目には繋がって見える。
 */
export function islandsOf(
  built: BuildResult,
  size = 96,
): { islands: number[]; nests: number; detached: number[] } {
  // 輪郭が 1 本なら島は 1 つしかありえない。画素を数えるのは
  // 1 回 16〜64 ms かかるので（paper の contains を画素ごとに呼ぶ）、
  // 数えるまでもない場合は先に返す。総当たりの検査で効く。
  const subpaths = built.parts.reduce((n, p) => n + (p.pathData.match(/M/g)?.length ?? 0), 0)
  if (subpaths <= 1) return { islands: subpaths === 1 ? [1] : [], nests: 0, detached: [] }

  const { gray } = rasterizeGray(built, { size })
  const N = size * size
  const ink = (i: number) => gray[i] < 128

  const near = (i: number): number[] => {
    const x = i % size
    const y = (i / size) | 0
    const out: number[] = []
    if (x > 0) out.push(i - 1)
    if (x < size - 1) out.push(i + 1)
    if (y > 0) out.push(i - size)
    if (y < size - 1) out.push(i + size)
    return out
  }

  // まず地（外側の白）を縁から塗る。ここに接していない白は「抜き」になる
  const outside = new Uint8Array(N)
  const queue: number[] = []
  for (let x = 0; x < size; x++) {
    for (const i of [x, x + (size - 1) * size]) if (!ink(i) && !outside[i]) (outside[i] = 1), queue.push(i)
  }
  for (let y = 0; y < size; y++) {
    for (const i of [y * size, y * size + size - 1]) if (!ink(i) && !outside[i]) (outside[i] = 1), queue.push(i)
  }
  while (queue.length > 0) {
    const i = queue.pop() as number
    for (const j of near(i)) if (!ink(j) && !outside[j]) (outside[j] = 1), queue.push(j)
  }

  type Blob = { area: number; x0: number; y0: number; x1: number; y1: number }
  const seen = new Uint8Array(N)
  const exposed: Blob[] = []
  let nests = 0
  const stack: number[] = []

  for (let start = 0; start < N; start++) {
    if (seen[start] || !ink(start)) continue
    const b: Blob = { area: 0, x0: size, y0: size, x1: -1, y1: -1 }
    let touchesGround = false
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const i = stack.pop() as number
      b.area++
      const x = i % size
      const y = (i / size) | 0
      if (x < b.x0) b.x0 = x
      if (x > b.x1) b.x1 = x
      if (y < b.y0) b.y0 = y
      if (y > b.y1) b.y1 = y
      for (const j of near(i)) {
        if (ink(j)) {
          if (!seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        } else if (outside[j]) {
          touchesGround = true
        }
      }
    }
    // 地に接していない墨は、白に囲まれた覗き（瞳・肋骨の間の点）。
    // これは意図された造形なので、浮いた部品とは別に数える
    if (touchesGround) exposed.push(b)
    else nests++
  }

  const total = exposed.reduce((a, b) => a + b.area, 0)
  if (total === 0) return { islands: [], nests, detached: [] }
  exposed.sort((a, b) => b.area - a.area)

  // 離れていること自体は失敗ではない。囲い（丸に三つ葉の丸）も、同心の
  // 波紋も、触れていないのが正しい。咎めるべきは「横に転がっている」もの。
  //
  // 見分けは枠の重なりで付く。囲いと同心は互いの枠が入れ子になるが、
  // 転がった塊は主役の枠の外に出る（実測: 同心の弧のマークは重なり 1.00、
  // 頭と肋骨に割れた生成物は 0.19）。
  const main = exposed[0]
  const overlap = (b: Blob) => {
    const w = Math.min(main.x1, b.x1) - Math.max(main.x0, b.x0)
    const h = Math.min(main.y1, b.y1) - Math.max(main.y0, b.y0)
    if (w <= 0 || h <= 0) return 0
    const smaller = Math.min(
      (main.x1 - main.x0) * (main.y1 - main.y0),
      (b.x1 - b.x0) * (b.y1 - b.y0),
    )
    return smaller > 0 ? (w * h) / smaller : 0
  }

  return {
    islands: exposed.map((b) => b.area / total),
    nests,
    detached: exposed.slice(1).filter((b) => overlap(b) < 0.5).map((b) => b.area / total),
  }
}

/**
 * 墨が自分の凸包をどれだけ埋めているか。
 *
 * 画素で測る。輪郭から求めると、離れた島や穴の扱いで別の話が混ざる。
 * 96 px で足りる（島の判定と同じ理由で、比は解像度でほとんど動かない）。
 */
export function solidityOf(built: BuildResult, size = 96): number {
  const { gray } = rasterizeGray(built, { size })
  const points: { x: number; y: number }[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (gray[y * size + x] < 128) points.push({ x, y })
  }
  if (points.length < 3) return 0

  // 凸包（Andrew の monotone chain）。画素は走査順に並んでいるので整列済み
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const half = (src: typeof sorted) => {
    const out: typeof sorted = []
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
      out.push(p)
    }
    return out.slice(0, -1)
  }
  const hull = [...half(sorted), ...half([...sorted].reverse())]

  let area = 0
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i]
    const q = hull[(i + 1) % hull.length]
    area += p.x * q.y - q.x * p.y
  }
  area = Math.abs(area) / 2
  return area > 0 ? Math.min(points.length / area, 1) : 0
}

export function measure(design: LogoDesign, built: BuildResult): Metrics {
  const span = Math.max(built.artBounds.width, built.artBounds.height) || 1
  const { vertices, corners, contours } = shapeOf(built, span * 0.01)
  // 半径は外接半径で正規化する。家紋の計測と同じ土俵に乗せるため
  const norm = span / 2
  const { islands, nests } = islandsOf(built)
  return {
    shapes: design.shapes.length,
    vertices,
    corners,
    contours,
    radii: distinctCount(radiiOf(design).map((r) => r / norm)),
    strokes: distinctCount(strokesOf(design).map((w) => w / norm)),
    ink: built.inkRatio,
    solidity: solidityOf(built),
    mirror: mirrorScore(built),
    islands,
    nests,
  }
}

/** 1 行の要約。前後比較を並べて読むための形。 */
export function formatMetrics(m: Metrics): string {
  return (
    `図形 ${String(m.shapes).padStart(3)} / 頂点 ${String(m.vertices).padStart(3)} / ` +
    `角 ${String(m.corners).padStart(3)} / 輪郭 ${String(m.contours).padStart(2)} / ` +
    `半径 ${m.radii} 種 / 線幅 ${m.strokes} 種 / ` +
    `インク ${(m.ink * 100).toFixed(0)}% / 塊 ${(m.solidity * 100).toFixed(0)}% / ` +
    `対称 ${(m.mirror * 100).toFixed(0)}%` +
    (m.nests > 0 ? ` / 覗き ${m.nests}` : '') +
    (m.islands.length > 1
      ? ` / 島 ${m.islands.length}（最小 ${(m.islands[m.islands.length - 1] * 100).toFixed(1)}%）`
      : '')
  )
}
