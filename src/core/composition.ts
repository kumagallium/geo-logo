import { z } from 'zod'
import type { Constraint, LogoDesign, Shape, Step } from './dsl'
import { PHI } from './units'

/**
 * 部品方式。具体的な題材（動物・道具・建物…）を扱うための構成モード。
 *
 * アーキタイプ方式（archetypes.ts）は 9 種の型から 1 つ選ぶだけなので、
 * 出せるマークが 9 種類しかない。「ゴリラ」のような具体的な題材を投げても、
 * 箱の中に無いものは出てこない。
 *
 * 有名な幾何ロゴを見直すと、実はどれもテンプレートではない。Twitter の鳥は
 * 大きさの違う円 13 個ほどの重なりで、配置は自由に決められている。共通するのは
 *   - 語彙が円・円弧・直線に限られる
 *   - 半径と位置が比例関係で決まる
 *   - 最後に合体して 1 つのシルエットになる
 * の 3 点だけ。つまり幾何グリッドは生成の道具ではなく、自由に置いた形を
 * 整える道具である。
 *
 * そこでモデルには「部品を置く」ことだけをさせ、破綻はコード側で直す。
 * 以前に自由な DSL 生成が壊れたのは、破綻を検出して**却下**していたためで、
 * 却下されたモデルは同じ失敗を繰り返した。ここでは却下せず修復する:
 *   - 浮いた部品は最も近い部品に接するまで寄せる（repairConnectivity）
 *   - 知らない語を使われたら既定値へ倒す（resolveForm / resolveRole）
 *   - 線が細すぎたら全体の寸法から下限を当てる
 * モデルは大まかな配置さえ出せればよく、賢くないモデルでも通る。
 */

export const FORMS = ['disc', 'ring', 'arc', 'vesica', 'bar'] as const
export type FormId = (typeof FORMS)[number]

export const FORM_GUIDE: Record<FormId, string> = {
  disc: '塗りつぶした円。頭・胴・目・実など、かたまりを表す最も基本の部品',
  ring: '中を抜いた環。目の縁・車輪・囲い',
  arc: '円弧の帯。眉・肩・翼・角・波・支えとなる曲線',
  vesica: '2 円の交差でできる葉形。耳・目・口・葉・鰭',
  bar: '直線の帯。脚・枝・軸・区切り',
}

/** モデルが別名を使ってくるので、既知の語へ寄せる。解決できなければ disc。 */
const FORM_ALIASES: Record<string, FormId> = {
  circle: 'disc',
  dot: 'disc',
  ellipse: 'disc',
  oval: 'disc',
  round: 'disc',
  sphere: 'disc',
  ball: 'disc',
  annulus: 'ring',
  donut: 'ring',
  doughnut: 'ring',
  torus: 'ring',
  curve: 'arc',
  crescent: 'arc',
  bow: 'arc',
  band: 'arc',
  swoosh: 'arc',
  leaf: 'vesica',
  eye: 'vesica',
  lens: 'vesica',
  almond: 'vesica',
  petal: 'vesica',
  line: 'bar',
  stick: 'bar',
  rod: 'bar',
  stroke: 'bar',
  rect: 'bar',
  rectangle: 'bar',
}

export function resolveForm(input: string): FormId {
  const key = input.trim().toLowerCase().replace(/[\s_-]+/g, '')
  for (const f of FORMS) if (key === f) return f
  if (FORM_ALIASES[key]) return FORM_ALIASES[key]
  for (const [alias, id] of Object.entries(FORM_ALIASES)) if (key.includes(alias)) return id
  for (const f of FORMS) if (key.includes(f)) return f
  return 'disc'
}

function resolveRole(input: string): 'add' | 'cut' {
  const key = input.trim().toLowerCase()
  return /cut|sub|remove|erase|negative|hole|抜|削/.test(key) ? 'cut' : 'add'
}

/**
 * 部品 1 つ。
 *
 * 数値の範囲はスキーマで丸めず clamp する（範囲外で検証を落とすと再試行になり
 * API コストが倍になるため）。z.number() 自体が来なかったときだけ既定値。
 */
const num = (min: number, max: number, fallback: number) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : v
      if (n === undefined || n === null || !Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    })

export const pieceSchema = z.object({
  label: z.union([z.string(), z.null()]).optional().transform((v) => (v ?? '').slice(0, 24)),
  form: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => resolveForm(typeof v === 'string' ? v : '')),
  role: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => resolveRole(typeof v === 'string' ? v : '')),
  x: num(-6, 6, 0),
  y: num(-6, 6, 0),
  size: num(0.15, 5, 1),
  angle: num(-360, 360, 0),
  span: num(20, 340, 180),
  thickness: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return k === 'thin' || k === 'bold' ? (k as 'thin' | 'bold') : ('regular' as const)
    }),
  mirror: z
    .union([z.boolean(), z.string(), z.null()])
    .optional()
    .transform((v) => v === true || v === 'true'),
})

export type Piece = z.infer<typeof pieceSchema>

export const compositionSchema = z.object({
  name: z.string().min(1).max(40),
  concept: z.string().min(1).max(600),
  ratio: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return k === 'silver' || k === 'integer' ? (k as 'silver' | 'integer') : ('golden' as const)
    }),
  // 12 部品 ×（左右対称で 2 倍）×（vesica は 2 円）= 最大 48 シェイプ。
  // DSL の上限 64 に収まる。
  pieces: z.array(pieceSchema).min(1).max(12),
})

export type Composition = z.infer<typeof compositionSchema>

const round = (v: number) => Math.round(v * 1000) / 1000

/**
 * 部品どうしを食い込ませる量。
 *
 * 固定値では足りない。この後に normalize が半径を最大 9%、座標を最大 0.07
 * モジュール動かすので、大きな部品どうしでは丸めだけで 0.5 モジュール以上
 * 離れうる（実測: でたらめな配置の検査で vesica が切り離された）。
 * 半径に比例した余裕を足して、丸めを吸収する。
 */
const requiredOverlap = (a: Anchor, b: Anchor) => 0.25 + 0.1 * (a.r + b.r)

/** 塗りの部品が、他の部品の輪郭から最低これだけ顔を出す量 */
const PROTRUDE = 0.4

/**
 * 当たり判定は 2 種類の円を使い分ける。
 *
 * 一律に (x, y, size) で見ると、形によって嘘になる:
 *   - vesica は 2 円の**交差**なので、できる形は size よりずっと小さい
 *   - arc と ring は中心が空洞で、インクは半径 size の位置にある
 *   - bar は軸方向へ size 伸びるが、直交方向には w/2 しかない
 * 実測（でたらめな配置 120 通りの検査）で、これが原因の「重なっているつもりで
 * 実際は離れている」が出た。
 *
 * inner: 必ずインクで埋まっている円。これどうしが重なれば実形も必ず重なるので、
 *        連結の修復に使う（多めに寄せることはあっても、離れたままにはならない）。
 * outer: 全体を覆う円。相手の inner に収まっていれば確実に埋もれているので、
 *        押し出しの判定に使う（確実な場合しか動かさない）。
 */
function innerOf(p: Piece, ratio: Composition['ratio']): Anchor {
  const rad = (p.angle * Math.PI) / 180
  const w = strokeOf(p.size, p.thickness)
  switch (p.form) {
    case 'vesica':
      // レンズに内接する円の半径は、法線方向の伸び size - d/2
      return { x: p.x, y: p.y, r: Math.max(p.size - vesicaOffset(p.size, ratio) / 2, 0.05) }
    case 'arc': {
      // 帯の中点に内接する円。角度が狭いと弧長のほうが制約になる
      const half = Math.min(w / 2, (p.size * p.span * Math.PI) / 360 / 2)
      return {
        x: p.x + Math.cos(rad) * p.size,
        y: p.y + Math.sin(rad) * p.size,
        r: Math.max(half, 0.05),
      }
    }
    case 'ring':
      return {
        x: p.x + Math.cos(rad) * (p.size - w / 2),
        y: p.y + Math.sin(rad) * (p.size - w / 2),
        r: Math.max(w / 2, 0.05),
      }
    case 'bar':
      return { x: p.x, y: p.y, r: Math.max(w / 2, 0.05) }
    default:
      return { x: p.x, y: p.y, r: p.size }
  }
}

function outerOf(p: Piece): Anchor {
  const w = strokeOf(p.size, p.thickness)
  switch (p.form) {
    case 'arc':
    case 'bar':
      return { x: p.x, y: p.y, r: p.size + w / 2 }
    default:
      return { x: p.x, y: p.y, r: p.size }
  }
}

/**
 * 左右対称の部品を展開する。
 *
 * 生き物の顔は対称なので、耳・目・肩は必ず対になる。モデルに 2 つ書かせると
 * 座標がわずかにずれて非対称になるが、片方だけ書かせて反転すれば対称性が
 * 構成上保証される。モデルが間違えられる箇所も半分になる。
 */
function expandMirrors(pieces: Piece[]): Piece[] {
  const out: Piece[] = []
  for (const p of pieces) {
    out.push(p)
    // x=0 の部品を反転しても同じ位置に重なるだけなので複製しない
    if (p.mirror && Math.abs(p.x) > 1e-6) {
      out.push({ ...p, x: -p.x, angle: 180 - p.angle })
    }
  }
  return out
}

type Comp = { members: number[]; weight: number }

/** 重なっている部品どうしを連結成分にまとめる */
function components(anchors: Array<{ x: number; y: number; r: number }>): Comp[] {
  const parent = anchors.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      if (gapBetween(anchors[i], anchors[j]) < -requiredOverlap(anchors[i], anchors[j])) union(i, j)
    }
  }

  const map = new Map<number, Comp>()
  for (let i = 0; i < anchors.length; i++) {
    const root = find(i)
    const c = map.get(root) ?? { members: [], weight: 0 }
    c.members.push(i)
    c.weight += anchors[i].r ** 2
    map.set(root, c)
  }
  return [...map.values()]
}

type Anchor = { x: number; y: number; r: number }

const gapBetween = (a: Anchor, b: Anchor) => Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r)

/** a から b へ向かう単位ベクトル。同心なら真下を向く（顔の部品では自然な向き）。 */
function direction(a: Anchor, b: Anchor): { ux: number; uy: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  return len < 1e-6 ? { ux: 0, uy: 1 } : { ux: dx / len, uy: dy / len }
}

/**
 * 浮いた部品を寄せて 1 つのまとまりにする。
 *
 * 却下ではなく修復にするのが要点。離れた部品を見つけたら、最も近い部品へ
 * 向かって食い込むまで平行移動する。成分ごと動かすので、既にできている
 * 部品どうしの関係は壊れない。
 */
export function repairConnectivity(
  input: Piece[],
  ratio: Composition['ratio'] = 'golden',
): { pieces: Piece[]; moved: number } {
  const pieces = input.map((p) => ({ ...p }))
  let moved = 0

  for (let pass = 0; pass < 8; pass++) {
    const anchors = pieces.map((p) => innerOf(p, ratio))
    const comps = components(anchors)
    if (comps.length <= 1) break

    // 最も大きな成分を動かさない基準にする
    comps.sort((a, b) => b.weight - a.weight)
    const base = comps[0]

    for (const comp of comps.slice(1)) {
      let best: { gap: number; from: number; to: number } | null = null
      for (const i of comp.members) {
        for (const j of base.members) {
          const gap = gapBetween(anchors[i], anchors[j])
          if (!best || gap < best.gap) best = { gap, from: i, to: j }
        }
      }
      if (!best) continue

      const d = best.gap + requiredOverlap(anchors[best.from], anchors[best.to])
      if (d <= 0) continue
      const { ux, uy } = direction(anchors[best.from], anchors[best.to])

      for (const i of comp.members) {
        pieces[i].x = round(pieces[i].x + ux * d)
        pieces[i].y = round(pieces[i].y + uy * d)
      }
      moved += comp.members.length
    }
  }
  return { pieces, moved }
}

/**
 * 他の部品に埋もれた塗り部品を、輪郭から顔を出すまで押し出す。
 *
 * repairConnectivity が「離れすぎ」を内へ寄せるのに対し、こちらは
 * 「埋まりすぎ」を外へ出す。合体すると消えてしまう部品は、モデルが意図して
 * 置いたのに完成形へ一切現れない（実測: ゴリラの眉と口元が頭の円に飲まれた）。
 *
 * 2 つを順に掛けると、どの部品も「重なっているが、はみ出してもいる」位置に
 * 落ち着く。円で構成された良いロゴが持つ配置そのもの。
 */
export function repairVisibility(
  input: Piece[],
  ratio: Composition['ratio'] = 'golden',
): { pieces: Piece[]; moved: number } {
  const pieces = input.map((p) => ({ ...p }))
  const bodies = pieces
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.role === 'add')
    .sort((a, b) => outerOf(b.p).r - outerOf(a.p).r)
  // 最大の部品は土台。これは動かさない
  let moved = 0

  for (const { i } of bodies.slice(1)) {
    for (let pass = 0; pass < 4; pass++) {
      const me = outerOf(pieces[i])

      // 自分を最も深く飲み込んでいる相手を探す。相手は inner で見るので、
      // 「確実に埋もれている」ときしか動かさない
      let host: { j: number; depth: number; at: Anchor } | null = null
      for (const { i: j } of bodies) {
        if (j === i) continue
        const at = innerOf(pieces[j], ratio)
        const depth = at.r - Math.hypot(me.x - at.x, me.y - at.y) - me.r
        if (!host || depth > host.depth) host = { j, depth, at }
      }
      // depth < 0 なら既に輪郭からはみ出している
      if (!host || host.depth < -PROTRUDE) break

      const d = host.depth + PROTRUDE
      const { ux, uy } = direction(host.at, me)
      pieces[i].x = round(pieces[i].x + ux * d)
      pieces[i].y = round(pieces[i].y + uy * d)
      moved++
    }
  }
  return { pieces, moved }
}

function strokeOf(size: number, thickness: Piece['thickness']): number {
  const k = thickness === 'thin' ? 1 / 7 : thickness === 'bold' ? 1 / 3 : 1 / 5
  return round(size * k)
}

/** ヴェシカを作る 2 円のずれ量。比例体系で鋭さが変わる。 */
function vesicaOffset(size: number, ratio: Composition['ratio']): number {
  const k = ratio === 'golden' ? 1 / PHI : ratio === 'silver' ? 1 / Math.SQRT2 : 0.5
  return round(size * k)
}

type Emitted = { shapes: Shape[]; groups: LogoDesign['groups']; ref: string }

function emit(piece: Piece, id: string, ratio: Composition['ratio'], minStroke: number): Emitted {
  const cx = round(piece.x)
  const cy = round(piece.y)
  const r = round(piece.size)
  const w = round(Math.max(strokeOf(piece.size, piece.thickness), minStroke))
  const rad = (piece.angle * Math.PI) / 180

  switch (piece.form) {
    case 'disc':
      return { shapes: [{ kind: 'circle', id, cx, cy, r }], groups: [], ref: id }

    case 'ring':
      // 線幅が半径以上になると環が潰れる
      return {
        shapes: [{ kind: 'ring', id, cx, cy, r, w: round(Math.min(w, r * 0.8)) }],
        groups: [],
        ref: id,
      }

    case 'arc': {
      const half = piece.span / 2
      return {
        shapes: [
          {
            kind: 'arc',
            id,
            cx,
            cy,
            r,
            w: round(Math.min(w, r * 1.2)),
            a0: round(piece.angle - half),
            a1: round(piece.angle + half),
            cap: 'round',
          },
        ],
        groups: [],
        ref: id,
      }
    }

    case 'vesica': {
      // 2 円を angle 方向の法線へずらして交差させる
      const d = vesicaOffset(piece.size, ratio) / 2
      const nx = -Math.sin(rad)
      const ny = Math.cos(rad)
      const gid = `${id}g`
      return {
        shapes: [
          { kind: 'circle', id: `${id}a`, cx: round(cx - nx * d), cy: round(cy - ny * d), r },
          { kind: 'circle', id: `${id}b`, cx: round(cx + nx * d), cy: round(cy + ny * d), r },
        ],
        groups: [
          {
            id: gid,
            steps: [
              { op: 'add', ref: `${id}a` },
              { op: 'intersect', ref: `${id}b` },
            ],
          },
        ],
        ref: gid,
      }
    }

    case 'bar': {
      const dx = Math.cos(rad) * piece.size
      const dy = Math.sin(rad) * piece.size
      return {
        shapes: [
          {
            kind: 'bar',
            id,
            x1: round(cx - dx),
            y1: round(cy - dy),
            x2: round(cx + dx),
            y2: round(cy + dy),
            w: round(Math.max(w, 0.12)),
            cap: 'round',
          },
        ],
        groups: [],
        ref: id,
      }
    }
  }
}

export type CompositionPlan = Composition & { palette?: LogoDesign['palette'] }

/**
 * 部品の並びから LogoDesign を組み立てる。
 *
 * モデルが決めるのは「何をどこにどれくらいの大きさで置くか」だけ。
 * ブーリアン演算の順序・id・参照・制約は一切書かせない（自由 DSL 生成が
 * 壊れた原因はほぼこの 4 つだった）。
 */
export function buildFromComposition(plan: CompositionPlan): LogoDesign {
  const parsed = compositionSchema.parse(plan)

  const expanded = expandMirrors(parsed.pieces)
  // 塗りが 1 つも無いと最初の演算が sub になり、何も生まれない。
  // 却下せず、最も大きな部品を塗りへ倒す。
  if (!expanded.some((p) => p.role === 'add')) {
    const biggest = expanded.reduce((a, b) => (b.size > a.size ? b : a))
    biggest.role = 'add'
  }

  // 内へ寄せてから外へ出す。順序が逆だと、押し出した部品を寄せ戻してしまう。
  const pulled = repairConnectivity(expanded, parsed.ratio).pieces
  const { pieces } = repairVisibility(pulled, parsed.ratio)

  // 線幅の下限は全体の寸法から決める。小さな部品の線幅をそのまま使うと、
  // 短辺の 1/25 を割ってファビコン相当のサイズで消える。
  const extent = Math.max(
    ...pieces.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)) + p.size),
    1,
  )
  const minStroke = round(extent * 0.11)

  const shapes: Shape[] = []
  const groups: LogoDesign['groups'] = []
  const adds: Step[] = []
  const cuts: Step[] = []

  pieces.forEach((piece, i) => {
    const out = emit(piece, `p${i}`, parsed.ratio, minStroke)
    shapes.push(...out.shapes)
    groups.push(...out.groups)
    ;(piece.role === 'add' ? adds : cuts).push({
      op: piece.role === 'add' ? 'add' : 'sub',
      ref: out.ref,
    })
  })

  // 塗りを先に全部合体させてから抜く。順序を固定するので、モデルが
  // 演算順を間違えて全体が消える事故が起きない。
  const steps: Step[] = [...adds, ...cuts]
  const constraints: Constraint[] = []

  return {
    name: parsed.name,
    concept: parsed.concept,
    module: 64,
    grid: parsed.ratio === 'silver' ? 'sqrt2' : 'golden',
    palette: plan.palette ?? {
      primary: '#111111',
      secondary: '#8A8A8A',
      accent: '#C2410C',
      background: '#FFFFFF',
    },
    shapes,
    constraints,
    groups,
    parts: [{ id: 'mark', steps, fill: 'primary', mirror: 'none' }],
  }
}
