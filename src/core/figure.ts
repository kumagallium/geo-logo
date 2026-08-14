import { z } from 'zod'
import { resolveForm, type FormId } from './composition'
import type { Constraint, LogoDesign, Shape, Step } from './dsl'
import { PHI } from './units'

/**
 * 関係で組む作図。
 *
 * 部品方式（composition.ts）は部品を平らな配列で持ち、座標を絶対値で受け取る。
 * 手で丁寧に書いた設計を通したところ、修復の各工程が設計そのものを上書きした:
 *
 *   - snapToLadder は拡大方向にしか寄せないので、頭:胴 = 1.29 が 1.00 に潰れた
 *   - enforceHierarchy は同率のときソート順で主役を選び、胴を頭より大きくした
 *   - repairVisibility が「目の環」を押し出したが、対になる「目の白」は残った
 *
 * 3 番目が本質で、部品どうしに関係が無いから片方だけ動かせてしまう。
 * ここでは位置を関係として受け取り、座標は導出する。関係があれば
 *
 *   - 動かすときは関係ごと動く（環と白が離れない）
 *   - 「円周上」「外接」がそのまま constraints になり、設計図に線として出る
 *   - 入れ子（黒→白→黒）が順序として表現できる
 *   - 同じ関係を n 個に増やせば、肋骨や棘のような反復になる
 *
 * が全部同じ仕組みから出る。
 */

/** 節点の置き方。そのまま DSL の制約になる。 */
export const GRIPS = ['on', 'outside', 'inside', 'center'] as const
export type GripId = (typeof GRIPS)[number]

export const GRIP_GUIDE: Record<GripId, string> = {
  on: '中心を親の円周上に置く（ヴェシカ。幾何ロゴで最も多い関係）',
  outside: '親に外から接する（耳・こぶ・実）',
  inside: '親に内から接する（目・窓・覗き）',
  center: '親と同心（輪を重ねる）',
}

const GRIP_ALIASES: Record<string, GripId> = {
  circumference: 'on',
  rim: 'on',
  edge: 'on',
  tangent: 'outside',
  external: 'outside',
  outer: 'outside',
  touch: 'outside',
  internal: 'inside',
  inner: 'inside',
  within: 'inside',
  concentric: 'center',
  same: 'center',
}

export function resolveGrip(input: string): GripId {
  const key = input.trim().toLowerCase().replace(/[\s_-]+/g, '')
  for (const g of GRIPS) if (key === g) return g
  return GRIP_ALIASES[key] ?? 'on'
}

const num = (min: number, max: number, fallback: number) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    })

const flag = z
  .union([z.boolean(), z.string(), z.null()])
  .optional()
  .transform((v) => v === true || v === 'true')

/** 層。外から内へ、墨と白を交互に置ける。 */
const layerSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
    return k === 'paper' || k === 'white' || k === 'hole' || k === '白' ? ('paper' as const) : ('ink' as const)
  })

export const figureNodeSchema = z.object({
  id: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) : '')),
  label: z.union([z.string(), z.null()]).optional().transform((v) => (v ?? '').slice(0, 24)),
  form: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => resolveForm(typeof v === 'string' ? v : '')),

  /** 親の id。省略すると絶対座標で置く */
  on: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) : '')),
  grip: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => resolveGrip(typeof v === 'string' ? v : '')),
  /** 親のどの向きに置くか（度、0 = 右、時計回り） */
  at: num(-360, 360, -90),

  x: num(-8, 8, 0),
  y: num(-8, 8, 0),

  /** 半径（親の半径に対する比ではなく、モジュールの実寸） */
  size: num(0.08, 6, 1),
  /** 部品自身の向き。省略すると親から見た外向き（at と同じ） */
  angle: z.union([z.number(), z.string(), z.null()]).optional().transform((v) => {
    const n = typeof v === 'string' ? Number.parseFloat(v) : v
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(360, Math.max(-360, n)) : null
  }),
  span: num(10, 340, 180),

  /** 同心の重ね。外から内へ。['ink','paper','ink'] で環・白・瞳になる */
  layers: z.array(layerSchema).max(5).optional().transform((v) => (v?.length ? v : (['ink'] as const))),

  /** 反復。親の曲線に沿って n 個並べる */
  count: num(1, 24, 1).transform((v) => Math.round(v)),
  /** 反復を散らす角度の幅。0 なら同心に外へ重ねる */
  spread: num(0, 340, 0),
  /** 同心反復の間隔（ペン幅に対する比） */
  pitch: num(1, 8, 2),
  /** 反復の端で size を何倍にするか（1 で一定） */
  taper: num(0.2, 2, 1),

  mirror: flag,
})

export type FigureNode = z.infer<typeof figureNodeSchema>

export const figureSchema = z.object({
  name: z.string().min(1).max(40),
  concept: z.string().min(1).max(600),
  ratio: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return k === 'silver' || k === 'integer' ? (k as 'silver' | 'integer') : ('golden' as const)
    }),
  /** 図全体で 1 本のペン幅。すべての環・弧・棒がこれを使う */
  pen: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return k === 'thin' || k === 'bold' ? (k as 'thin' | 'bold') : ('regular' as const)
    }),
  nodes: z.array(figureNodeSchema).min(1).max(40),
})

export type Figure = z.infer<typeof figureSchema>
export type FigurePlan = Figure & { palette?: LogoDesign['palette'] }

const round = (v: number) => Math.round(v * 1000) / 1000
const rad = (deg: number) => (deg * Math.PI) / 180

function ladderStep(ratio: Figure['ratio']): number {
  return ratio === 'silver' ? Math.SQRT2 : ratio === 'integer' ? 1.5 : PHI
}

/** ペン幅。外接半径に対する比で決める（家紋の実測は 0.06〜0.13 に収まる）。 */
function penWidth(reach: number, pen: Figure['pen']): number {
  const k = pen === 'thin' ? 0.055 : pen === 'bold' ? 0.13 : 0.085
  return round(Math.max(reach * k, 0.04))
}

type Placed = {
  node: FigureNode
  /** 反復した 1 個ぶんの位置と向きと寸法 */
  copies: Array<{ x: number; y: number; angle: number; size: number }>
  /** 親（居れば）。制約を張るのに使う */
  host: string | null
}

/**
 * 親の曲線上の点を返す。
 *
 * 「円周に沿って」だけでは肋骨が置けない。背骨は棒か弧で、その軸に沿って
 * 並べたい。親の形ごとに「沿う曲線」を定義しておくと、反復の指定は
 * どの親に対しても `count` と `spread` の 2 つで済む。
 */
function alongHost(
  host: { x: number; y: number; size: number; angle: number; span: number; form: FormId },
  t: number,
  at: number,
  spread: number,
): { x: number; y: number; normal: number } {
  // t は -0.5 〜 0.5
  if (host.form === 'bar') {
    // 軸に沿って。spread は軸の何割を使うか（既定は全長）
    const use = spread > 0 ? Math.min(spread / 340, 1) : 1
    const d = t * 2 * host.size * use
    const c = Math.cos(rad(host.angle))
    const s = Math.sin(rad(host.angle))
    return { x: host.x + c * d, y: host.y + s * d, normal: host.angle + 90 }
  }
  if (host.form === 'arc') {
    // 弧の開き角の内側に収める
    const use = spread > 0 ? Math.min(spread, host.span) : host.span
    const a = host.angle + t * use
    return {
      x: host.x + Math.cos(rad(a)) * host.size,
      y: host.y + Math.sin(rad(a)) * host.size,
      normal: a,
    }
  }
  const a = at + t * spread
  return {
    x: host.x + Math.cos(rad(a)) * host.size,
    y: host.y + Math.sin(rad(a)) * host.size,
    normal: a,
  }
}

/**
 * 節点を解決して座標を求める。
 *
 * 親が先に解決している必要があるので、解けるものから順に何度か回す。
 * 解けない参照（存在しない id・循環）は絶対座標へ落とす。却下しない。
 */
export function placeNodes(nodes: FigureNode[], ratio: Figure['ratio']): Placed[] {
  const byId = new Map<string, FigureNode>()
  nodes.forEach((n, i) => byId.set(n.id || `n${i}`, n))

  const done = new Map<string, Placed>()
  const order: Placed[] = []
  const pending = nodes.map((n, i) => ({ n, key: n.id || `n${i}` }))

  for (let pass = 0; pass < nodes.length + 1 && pending.length > 0; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const { n, key } = pending[i]
      const host = n.on && byId.has(n.on) && n.on !== key ? done.get(n.on) : undefined
      if (n.on && n.on !== key && byId.has(n.on) && !host) continue // 親がまだ

      const copies: Placed['copies'] = []
      const count = Math.max(1, n.count)

      if (!host) {
        // 親なし。絶対座標に置く
        for (let k = 0; k < count; k++) {
          const t = count === 1 ? 0 : k / (count - 1) - 0.5
          copies.push({
            x: round(n.x),
            y: round(n.y),
            angle: n.angle ?? n.at,
            size: round(n.size * taperAt(n.taper, t)),
          })
        }
      } else {
        // 反復する親（肋骨のような）の中央を基準にする
        const h = host.copies[Math.floor(host.copies.length / 2)]
        const hostForm = host.node.form
        const curved = hostForm === 'bar' || hostForm === 'arc'
        for (let k = 0; k < count; k++) {
          const t = count === 1 ? 0 : k / (count - 1) - 0.5
          const size = round(n.size * taperAt(n.taper, t))

          // 散らさない反復は同心に外へ重ねる（音の輪・波紋）
          if (n.spread === 0 && count > 1 && !curved) {
            const gap = n.pitch * n.size * 0.35
            copies.push({ x: h.x, y: h.y, angle: n.angle ?? n.at, size: round(n.size + k * gap) })
            continue
          }

          const p = alongHost(
            { x: h.x, y: h.y, size: h.size, angle: h.angle, span: host.node.span, form: hostForm },
            t,
            n.at,
            n.spread,
          )
          // 円を親にしたときは中心からの距離で、線を親にしたときは法線方向の
          // ずらしで置く。どちらも「触れている位置」を関係が決める
          const off = curved ? offsetAlongNormal(n.grip, size) : 0
          const dist = curved ? 0 : gripOffset(n.grip, h.size, size) - h.size
          const c = Math.cos(rad(p.normal))
          const s = Math.sin(rad(p.normal))
          copies.push({
            x: round(p.x + c * (dist + off)),
            y: round(p.y + s * (dist + off)),
            angle: n.angle ?? p.normal,
            size,
          })
        }
      }

      const placed: Placed = { node: n, copies, host: host ? (n.on ?? null) : null }
      done.set(key, placed)
      order.push(placed)
      pending.splice(i, 1)
    }
  }
  // 解けなかったものは絶対座標で置く
  for (const { n } of pending) {
    order.push({
      node: n,
      copies: [{ x: n.x, y: n.y, angle: n.angle ?? n.at, size: n.size }],
      host: null,
    })
  }
  return order
}

/** 反復の端で寸法を変える係数 */
function taperAt(taper: number, t: number): number {
  // t は -0.5（先頭）〜 0.5（末尾）。中央を 1 とし、端で taper へ寄せる
  return 1 + (taper - 1) * Math.abs(t) * 2
}

/** 線を親にしたときの、法線方向へのずらし量 */
function offsetAlongNormal(grip: GripId, ownR: number): number {
  switch (grip) {
    case 'outside':
      return ownR
    case 'inside':
      return -ownR
    default:
      return 0
  }
}

/** 親の中心からの距離。置き方がそのまま距離を決める。 */
function gripOffset(grip: GripId, hostR: number, ownR: number): number {
  switch (grip) {
    case 'outside':
      return hostR + ownR
    case 'inside':
      return Math.max(hostR - ownR, 0)
    case 'center':
      return 0
    default:
      return hostR
  }
}

/** 置き方に対応する DSL の制約 */
function constraintFor(grip: GripId, child: string, host: string): Constraint | null {
  switch (grip) {
    case 'outside':
      return { type: 'tangent', a: child, b: host, mode: 'external' }
    case 'inside':
      return { type: 'tangent', a: child, b: host, mode: 'internal' }
    case 'center':
      return { type: 'concentric', a: child, b: host }
    default:
      return { type: 'onCircle', point: child, circle: host }
  }
}

/** 1 つの層を図形にする。ペン幅は図全体で共有する。 */
function shapeFor(
  form: FormId,
  id: string,
  c: { x: number; y: number; angle: number; size: number },
  r: number,
  pen: number,
  span: number,
  ratio: Figure['ratio'],
): { shapes: Shape[]; ref: string } {
  switch (form) {
    case 'ring':
      return {
        shapes: [{ kind: 'ring', id, cx: c.x, cy: c.y, r, w: round(Math.min(pen, r * 0.8)) }],
        ref: id,
      }
    case 'arc':
      return {
        shapes: [
          {
            kind: 'arc',
            id,
            cx: c.x,
            cy: c.y,
            r,
            w: round(Math.min(pen, r * 1.2)),
            a0: round(c.angle - span / 2),
            a1: round(c.angle + span / 2),
            cap: 'butt',
          },
        ],
        ref: id,
      }
    case 'bar':
      return {
        shapes: [
          {
            kind: 'bar',
            id,
            x1: round(c.x - Math.cos(rad(c.angle)) * r),
            y1: round(c.y - Math.sin(rad(c.angle)) * r),
            x2: round(c.x + Math.cos(rad(c.angle)) * r),
            y2: round(c.y + Math.sin(rad(c.angle)) * r),
            w: round(pen),
            cap: 'butt',
          },
        ],
        ref: id,
      }
    case 'vesica': {
      // 2 円の交差。ずれ量が鋭さを決める
      const d = round((r / ladderStep(ratio)) / 2)
      const nx = -Math.sin(rad(c.angle))
      const ny = Math.cos(rad(c.angle))
      return {
        shapes: [
          { kind: 'circle', id: `${id}a`, cx: round(c.x - nx * d), cy: round(c.y - ny * d), r },
          { kind: 'circle', id: `${id}b`, cx: round(c.x + nx * d), cy: round(c.y + ny * d), r },
        ],
        ref: `${id}G`,
      }
    }
    default:
      return { shapes: [{ kind: 'circle', id, cx: c.x, cy: c.y, r }], ref: id }
  }
}

/**
 * 節点の並びから LogoDesign を組み立てる。
 *
 * 演算は宣言順の逐次適用にする。部品方式は「塗りを全部足してから抜く」
 * 順に並べ替えていたので、環・白・瞳の入れ子が作れなかった（白が瞳を
 * 消す）。逐次にすれば入れ子が順序としてそのまま表現できる。
 */
export function buildFromFigure(plan: FigurePlan): LogoDesign {
  const parsed = figureSchema.parse(plan)

  // 鏡像は関係ごと反転する。片側だけ書けば対が構成上そろう
  const expanded: FigureNode[] = []
  for (const n of parsed.nodes) {
    expanded.push(n)
    if (n.mirror) {
      expanded.push({
        ...n,
        id: `${n.id}M`,
        // 親も鏡像側を見る（親が軸上なら元のまま）
        on: n.on && parsed.nodes.some((m) => m.id === n.on && m.mirror) ? `${n.on}M` : n.on,
        at: 180 - n.at,
        x: -n.x,
        angle: n.angle === null ? null : 180 - n.angle,
      })
    }
  }

  const placed = placeNodes(expanded, parsed.ratio)

  // ペン幅は図の大きさから決める。部品ごとに決めると太さが揃わない
  const reach = Math.max(
    ...placed.flatMap((p) => p.copies.map((c) => Math.hypot(c.x, c.y) + c.size)),
    1,
  )
  const pen = penWidth(reach, parsed.pen)
  const stepDown = ladderStep(parsed.ratio)

  const shapes: Shape[] = []
  const groups: LogoDesign['groups'] = []
  const steps: Step[] = []
  const constraints: Constraint[] = []
  const radiusOf = new Map<string, number>()

  placed.forEach((p, i) => {
    const base = p.node.id || `n${i}`
    p.copies.forEach((c, k) => {
      const tag = p.copies.length > 1 ? `${base}_${k}` : base
      p.node.layers.forEach((layer, li) => {
        const r = round(c.size / stepDown ** li)
        if (r < pen * 0.35) return // 層が細くなりすぎたら置かない
        const id = li === 0 ? tag : `${tag}L${li}`
        const out = shapeFor(p.node.form, id, c, r, pen, p.node.span, parsed.ratio)
        shapes.push(...out.shapes)
        if (out.ref.endsWith('G')) {
          groups.push({
            id: out.ref,
            steps: [
              { op: 'add', ref: `${id}a` },
              { op: 'intersect', ref: `${id}b` },
            ],
          })
        }
        steps.push({ op: layer === 'paper' ? 'sub' : 'add', ref: out.ref })
        if (li === 0) radiusOf.set(id, r)
        // 層どうしは同心。これを宣言しておくと設計図に関係が出る
        if (li > 0) constraints.push({ type: 'concentric', a: id, b: tag })
      })
      // 親との関係。反復した個体それぞれに張る
      if (p.host && radiusOf.has(tag)) {
        const hostPlaced = placed.find((q) => (q.node.id || '') === p.host)
        const hostTag =
          hostPlaced && hostPlaced.copies.length > 1
            ? `${p.host}_${Math.min(k, hostPlaced.copies.length - 1)}`
            : p.host
        if (radiusOf.has(hostTag)) {
          const c2 = constraintFor(p.node.grip, tag, hostTag)
          if (c2) constraints.push(c2)
        }
      }
    })
  })

  // 最初の演算が抜きだと何も生まれない
  if (steps.length > 0 && steps[0].op !== 'add') steps[0] = { ...steps[0], op: 'add' }

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
