import { z } from 'zod'
import type { LogoDesign, Shape, Step } from './dsl'
import {
  fitToModule,
  harmonizeRadii,
  offsetContour,
  smoothJoints,
  traceArcs,
  type ContourSegment,
  type Vec,
} from './trace'

/**
 * 輪郭の通過点から作図する。
 *
 * 部品方式は円を詰めて形を作る。円を詰めると質量が平均化され、どんな題材も
 * 丸い団子になった（ゴリラの肩の張りが消える）。円は「面を埋める」道具で、
 * 「輪郭を決める」道具ではない。
 *
 * 家紋の逆算で作った機構——輪郭を円弧の連なりにする・継ぎ目の接線を揃える・
 * 半径を数種類に揃える——は既に動いている。足りなかったのは入力の側で、
 * 「円の中心と半径」ではなく「輪郭が通る点」を受け取れば、同じ機構がその
 * まま具象の輪郭に効く。画像を経由せず、順方向のまま具象へ届く道。
 */

const num = (min: number, max: number, fallback: number) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
      return Math.min(Math.max(n, min), max)
    })

/** 書かれていなければ undefined を返す（＝上位の既定に従う） */
const optNum = (min: number, max: number) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
      return Math.min(Math.max(n, min), max)
    })

const pointSchema = z.object({ x: num(-10, 10, 0), y: num(-10, 10, 0) })

/**
 * キーラインの幅の上限（モジュール）。
 *
 * 点はどう書かれても 5 モジュール四方へ収められる（`prepare`）ので、モジュール
 * 単位の幅はそのままマークに対する一定の比になる。0.5 はマークの 10% で、
 * 実用にはありえない太さ。上限は暴走を止めるためだけに置く。
 */
const KEYLINE_MAX = 0.5

/**
 * 円弧の当てはめの許容誤差（輪郭の大きさに対する比）。
 *
 * 0.06 は「点 6〜14」向けに決めた値で、密なラフには緩すぎた。実測で 0.06 /
 * 0.025 / 0.012 を熊とジャッカルの両方に当てたところ、0.06 は輪郭が 3 つの円へ
 * 潰れ（耳も口吻も消える）、0.012 は逆に点をなぞって凸凹が残った。0.025 で
 * 両方とも口吻・耳・目・キーラインが揃う。
 *
 * さらに、点が増えるほど描いた側の意図は細かくなるので、基準の点数からの比で
 * 緩める。
 */
const TOLERANCE = 0.025
const BASE_POINTS = 14

const toleranceFor = (points: number, polish: number): number =>
  TOLERANCE * polish * Math.min(1, BASE_POINTS / Math.max(points, 1))

export const outlineContourSchema = z.object({
  label: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v ?? '').slice(0, 24)),
  role: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return k === 'hole' || k === 'sub' || k === 'cut' ? ('hole' as const) : ('solid' as const)
    }),
  // 4 点未満では閉じた輪郭にならない。
  //
  // 上限は 24 から 64 へ上げた。24 は弱いモデル向けの設定で、「点を増やすと
  // 写生になる」という理屈で絞っていたが、実際に効いていたのは点の数ではなく
  // **円弧に均す工程**のほうだった。人がラフを描くときも 20 点では足りない。
  // 円弧の本数は許容誤差で決まるので、点を増やしても作図の粗さは変わらない。
  points: z.array(pointSchema).min(4).max(64),
  /** この輪郭だけキーラインの幅を変える。省略で全体の既定に従う */
  keyline: optNum(0, KEYLINE_MAX),
})

export const outlineSchema = z.object({
  name: z.string().min(1).max(40),
  concept: z.string().min(1).max(600),
  /** 左右対称にするか。対称なら軸を 1 本に決めて、片側から反転する */
  symmetry: z
    .union([z.boolean(), z.string(), z.null()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  // 上限 12。四足の生き物を描くと、体＋奥の 2 脚＋目・鼻・耳・首とキーライン
  // 2 本で 9 本になり、8 では足りなかった（実測。熊を描いていて当たった）
  contours: z.array(outlineContourSchema).min(1).max(12),
  /**
   * どれくらい整えるか。1 が標準、小さいほどラフに忠実、大きいほど畳む。
   *
   * 許容誤差はもともと「点 6〜14」向けに 0.06 と粗く決めてあった。密なラフを
   * 通すと畳みすぎる（実測: 点 31 のジャッカルの頭部が弧 6 本になり、耳の
   * 切れ込みが 1 本の弧に均された）。ラフの密度に応じて呼ぶ側が決められる
   * ようにする。
   */
  polish: num(0.3, 3, 1),
  /**
   * 重なった部品を分ける白の筋の幅（モジュール）。0 で無し。
   *
   * 洗練された紋章ロゴが例外なく持っている操作。翼と胴、首と胸、顎と頬——
   * 重なりの境目がどこも同じ太さの白で分かれている。これが無いと部品が
   * 黒い塊へ溶ける。
   *
   * 関係方式の `outline` と同じ仕掛け（太らせた同じ形を先に抜いてから本体を
   * 置く）だが、幅の基準が違う。あちらはペン幅の倍数で、こちらはモジュール。
   * 輪郭方式にはペンが無く、幅は「マークに対して一定」であってほしいため。
   *
   * これを入れる前は、手で細長い `hole` を引いて白を作っていた。境目ごとに
   * 座標を書くので幅が揃わず、輪郭を直すたびに引き直すことになっていた。
   */
  keyline: num(0, KEYLINE_MAX, 0),
})

export type OutlinePlan = z.infer<typeof outlineSchema> & { palette?: LogoDesign['palette'] }

/**
 * 通過点の間を滑らかに繋ぐ（中心化 Catmull-Rom）。
 *
 * 点をそのまま円弧に当てはめると、点の間隔がそのまま円弧の刻みになって
 * 折れる。先に滑らかな曲線を通してから当てはめると、点の数と円弧の本数が
 * 切り離せる（通過点 10 個から円弧 5 本、ということが起きる）。
 */
function spline(points: Vec[], closed: boolean, perSegment: number): Vec[] {
  const n = points.length
  if (n < 2) return points
  // 開いた区間の端は、1 つ内側を折り返した仮の点で補う
  const at = (i: number): Vec => {
    if (closed) return points[((i % n) + n) % n]
    if (i < 0) return { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y }
    if (i > n - 1) {
      return {
        x: 2 * points[n - 1].x - points[n - 2].x,
        y: 2 * points[n - 1].y - points[n - 2].y,
      }
    }
    return points[i]
  }
  const last = closed ? n - 1 : n - 2
  const out: Vec[] = []
  for (let i = 0; i <= last; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    // 中心化（α=0.5）。一様だと点が密なところで曲線が飛び出す
    const t = [0, 0, 0, 0]
    for (let k = 1; k < 4; k++) {
      const a = [p0, p1, p2, p3][k - 1]
      const b = [p0, p1, p2, p3][k]
      t[k] = t[k - 1] + Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) || t[k - 1] + 1e-6
    }
    for (let s = 0; s < perSegment; s++) {
      const tt = t[1] + ((t[2] - t[1]) * s) / perSegment
      const lerp = (a: Vec, b: Vec, ta: number, tb: number) => {
        const u = tb === ta ? 0 : (tt - ta) / (tb - ta)
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
      }
      const a1 = lerp(p0, p1, t[0], t[1])
      const a2 = lerp(p1, p2, t[1], t[2])
      const a3 = lerp(p2, p3, t[2], t[3])
      const b1 = lerp(a1, a2, t[0], t[2])
      const b2 = lerp(a2, a3, t[1], t[3])
      out.push(lerp(b1, b2, t[1], t[2]))
    }
  }
  if (!closed) out.push(points[n - 1])
  return out
}

/**
 * ラフの鋭角を残したまま、間を滑らかに繋ぐ。
 *
 * 閉じた曲線として一気に補間すると、描いた側が意図した角も均される。
 * 実測: ジャッカルの立った耳 2 本と羽根が、1 つの丸い瘤に溶けた。
 *
 * 制御点を二重にする定石は、中心化パラメータだと点間距離が 0 になって
 * 補間が壊れる（魚の尾が消えた）。**角で切って、区間ごとに開いた曲線として
 * 補間する。** 角はそのまま通過点なので厳密に残る。
 */
function interpolate(points: Vec[], perSegment = 16, cornerDegrees = 60): Vec[] {
  const n = points.length
  if (n < 4) return points

  const limit = (cornerDegrees * Math.PI) / 180
  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur = points[i]
    const next = points[(i + 1) % n]
    const a = Math.atan2(cur.y - prev.y, cur.x - prev.x)
    const b = Math.atan2(next.y - cur.y, next.x - cur.x)
    if (Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) > limit) corners.push(i)
  }
  if (corners.length === 0) return spline(points, true, perSegment)

  const out: Vec[] = []
  for (let k = 0; k < corners.length; k++) {
    const from = corners[k]
    const to = corners[(k + 1) % corners.length]
    const run: Vec[] = [points[from]]
    let i = from
    do {
      i = (i + 1) % n
      run.push(points[i])
    } while (i !== to)
    // 末尾は次の区間の先頭と重なるので落とす
    out.push(...spline(run, false, perSegment).slice(0, -1))
  }
  return out
}

/** 左右対称にする。軸は x=0 に決め打つ（マーク全体で 1 本に揃えるため）。 */
function symmetrize(points: Vec[]): Vec[] {
  // 右半分だけを残し、折り返して閉じる。左右で点の数が違っても揃う
  const right = points.filter((p) => p.x >= 0)
  if (right.length < 3) return points
  const sorted = [...right].sort((a, b) => a.y - b.y)
  const back = [...sorted].reverse().map((p) => ({ x: -p.x, y: p.y }))
  return [...sorted, ...back]
}

/** 点を紙面に収め、原点へ寄せる。ラフの絶対値をそのまま寸法にしない。 */
function prepare(parsed: OutlinePlan): Vec[][] {
  const raw = parsed.contours.map((c) => (parsed.symmetry ? symmetrize(c.points) : c.points))
  const scaled = fitToModule(raw, 5)
  const all = scaled.flat()
  const cx = (Math.min(...all.map((p) => p.x)) + Math.max(...all.map((p) => p.x))) / 2
  const cy = (Math.min(...all.map((p) => p.y)) + Math.max(...all.map((p) => p.y))) / 2
  return scaled.map((c) => c.map((p) => ({ x: p.x - cx, y: p.y - cy })))
}

/**
 * ラフから完成形までの各段を、そのまま取り出す。
 *
 * 点を書いてシルエットだけを見ていると、**どの点が悪いのか分からない**。
 * 直すたびに勘で座標を動かすことになる。点・補間した曲線・当てはめた円弧を
 * 重ねて見られれば、直す場所が一目で決まる。人が下描きを直すときに
 * 見ているものと同じ。
 */
export type OutlineStage = {
  label: string
  role: 'solid' | 'hole'
  /** 紙面に収めたあとの入力点 */
  points: Vec[]
  /** 角を残したまま補間した密な点列 */
  dense: Vec[]
  /** 当てはめた円弧（半径を揃える前） */
  segments: ReturnType<typeof traceArcs>['segments']
  /** 先に抜かれる縁取りの形。無い輪郭では空 */
  keyline: ContourSegment[]
}

/** この輪郭に敷くキーラインの幅。抜きには要らない（もともと白なので） */
function keylineOf(parsed: OutlinePlan, i: number): number {
  const c = parsed.contours[i]
  if (c.role === 'hole') return 0
  return c.keyline ?? parsed.keyline
}

export function outlineStages(plan: OutlinePlan): OutlineStage[] {
  const parsed = outlineSchema.parse(plan)
  return prepare(parsed).map((points, i) => {
    const dense = interpolate(points)
    const segments = traceArcs(dense, {
      toleranceRatio: toleranceFor(points.length, parsed.polish),
      mirrorX: parsed.symmetry ? 0 : undefined,
      snapRadii: true,
    }).segments
    const width = keylineOf(parsed, i)
    return {
      label: parsed.contours[i].label || `輪郭 ${i + 1}`,
      role: parsed.contours[i].role,
      points,
      dense,
      segments,
      // 完成形と同じ手順（継ぎ目を揃えてから等距離に移す）で作る。
      // 半径を揃える前なので本番とは僅かにずれるが、幅を決めるには足りる
      keyline: width > 0 ? offsetContour(smoothJoints(segments), width) : [],
    }
  })
}

export function buildFromOutline(plan: OutlinePlan): LogoDesign {
  const parsed = outlineSchema.parse(plan)
  const fitted = prepare(parsed)

  const shapes: Shape[] = []
  /** 描けた輪郭。演算の順はキーラインを決めてからまとめて組む */
  const drawn: { id: string; role: 'solid' | 'hole'; keyline: number }[] = []
  fitted.forEach((points, i) => {
    const dense = interpolate(points)
    // 本数ではなく許容誤差で切る。本数指定は冗長な弧を並べたうえ精度も落ちる
    const { segments: fit } = traceArcs(dense, {
      // 粗く切る。細かく刻むと点をなぞるだけになり、円弧に均す意味が消える
      toleranceRatio: toleranceFor(points.length, parsed.polish),
      mirrorX: parsed.symmetry ? 0 : undefined,
      // 作図側では半径を比例体系へ寄せる。トレースでは元の形が設計なので
      // 寄せると壊れるが、こちらは寄せることが目的（作図した形にする）
      snapRadii: true,
    })
    const segments = smoothJoints(fit)
    if (segments.length < 3) return
    shapes.push({ kind: 'contour', id: `o${i}`, segments })
    drawn.push({ id: `o${i}`, role: parsed.contours[i].role, keyline: keylineOf(parsed, i) })
  })

  if (shapes.length === 0) {
    // 却下せず、点をそのまま多角形として出す。形は粗いが空にはならない
    // （多角形は等距離に移せないので、この経路ではキーラインを諦める）
    fitted.forEach((points, i) => {
      shapes.push({ kind: 'poly', id: `o${i}`, points })
      drawn.push({ id: `o${i}`, role: parsed.contours[i].role, keyline: 0 })
    })
  }

  // 半径を数種類へ揃える。ここが「描かれたもの」と「作図されたもの」を分ける。
  //
  // 家紋の実測では半径は 3〜5 種。既定の許容差（3%）はトレース用で、
  // 当てはめ誤差を畳むだけなので生成側では緩すぎない（14 種残った）。
  // 目標の種類数に届くまで許容差を広げる。
  const contours = shapes.filter((s) => s.kind === 'contour')
  if (contours.length > 0) {
    const groups = contours.map((s) => (s.kind === 'contour' ? s.segments : []))
    let tuned = harmonizeRadii(groups)
    for (let tol = 0.1; tuned.radii.length > 5 && tol <= 0.8; tol += 0.1) {
      tuned = harmonizeRadii(groups, tol)
    }
    contours.forEach((s, i) => {
      if (s.kind === 'contour') s.segments = tuned.groups[i]
    })
  }

  // 白の縁取り（キーライン）。太らせた同じ形を先に抜いてから本体を置くと、
  // 先に置かれた部品との境目に一定幅の白が残る。**順序がすべて**で、塗りを
  // 全部足してから抜く従来の並べ方では、縁取りが後から来た部品まで削る。
  //
  // 半径を揃えたあとの形から作る。揃える前に作ると、本体だけが畳まれて
  // 幅がばらつく（キーラインは畳みの対象に入れない）。
  //
  // 抜き（hole）は最後にまとめる。目や切れ込みは完成したシルエットに対して
  // 開けるもので、あとから足される部品に埋められては困る。
  const ordered: Step[] = []
  drawn
    .filter((d) => d.role === 'solid')
    .forEach((d, i) => {
      const shape = shapes.find((s) => s.id === d.id)
      // 1 枚目の下には敷くものが無い。抜きから始めると何も生まれないので置かない
      if (i > 0 && d.keyline > 0 && shape?.kind === 'contour') {
        shapes.push({
          kind: 'contour',
          id: `${d.id}K`,
          segments: offsetContour(shape.segments, d.keyline),
        })
        ordered.push({ op: 'sub', ref: `${d.id}K` })
      }
      ordered.push({ op: 'add', ref: d.id })
    })
  for (const d of drawn) {
    if (d.role === 'hole') ordered.push({ op: 'sub', ref: d.id })
  }

  return {
    name: parsed.name,
    concept: parsed.concept,
    module: 64,
    grid: 'golden',
    palette: plan.palette ?? {
      primary: '#111111',
      secondary: '#8A8A8A',
      accent: '#C2410C',
      background: '#FFFFFF',
    },
    shapes,
    constraints: [],
    groups: [],
    parts: [{ id: 'mark', steps: ordered, fill: 'primary', mirror: 'none' }],
  }
}

/** 円弧の本数と半径の種類。作図されているかを測る。 */
export function outlineStats(design: LogoDesign): { arcs: number; radii: number } {
  const groups = design.shapes
    // キーラインは本体の複製なので数に入れない。入れると本数が倍近くになり、
    // 半径も ±幅 の分だけ増えて、作図の粗さが実際より悪く見える
    .filter((s) => s.kind === 'contour' && !s.id.endsWith('K'))
    .map((s) => (s.kind === 'contour' ? s.segments : []))
  const arcs = groups.reduce((n, g) => n + g.length, 0)
  return { arcs, radii: harmonizeRadii(groups).radii.length }
}
