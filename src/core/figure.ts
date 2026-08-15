import { z } from 'zod'
import { resolveForm as resolveBaseForm } from './composition'
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

/**
 * 使える形。部品方式の語彙に「四肢」を足したもの。
 *
 * 一定の太さの棒では、腕も脚も尾も同じ太さの線になる。生き物の四肢は
 * 付け根が太く先が細い。太さの違う 2 円を外接接線で包むと、円と直線だけで
 * テーパーが出る——古典的な作図そのもので、自由曲線を使わずに済む。
 */
export const FIGURE_FORMS = ['disc', 'ring', 'arc', 'bar', 'vesica', 'limb'] as const
export type FigureFormId = (typeof FIGURE_FORMS)[number]

const LIMB_WORDS = /limb|taper|cone|arm|leg|tail|horn|claw|finger|肢|腕|脚|尾|角/

export function resolveFigureForm(input: string): FigureFormId {
  const key = input.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (key === 'limb') return 'limb'
  // 別名で来ることが多いので、棒に落ちる前に四肢を拾う
  if (LIMB_WORDS.test(key) && key !== 'bar') return 'limb'
  return resolveBaseForm(key) as FigureFormId
}

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
    .transform((v) => resolveFigureForm(typeof v === 'string' ? v : '')),

  /** 親の id。省略すると絶対座標で置く */
  on: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) : '')),
  grip: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => resolveGrip(typeof v === 'string' ? v : '')),
  /**
   * 親のどこに置くか。数でも言葉でも書ける。
   *
   * 親が円（disc / ring / vesica）なら角度（度、0 = 右、時計回り）か、
   * "up" / "down" / "left" / "upleft" などの方角。
   * 親が線（arc / bar）なら線上の位置（-50 が始点、0 が中央、50 が終点）か、
   * "start" / "middle" / "end"。
   *
   * 言葉を受けるのは、角度の符号と回る向きを間違える出力が多かったため。
   * 「頭は胴の上」を -90 と書くのは、y が下向きだと知っていないとできない。
   */
  at: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v): number | string | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return Math.min(360, Math.max(-360, v))
      if (typeof v !== 'string') return null
      const n = Number.parseFloat(v)
      if (Number.isFinite(n) && /^\s*-?[\d.]+\s*$/.test(v)) return Math.min(360, Math.max(-360, n))
      return v.trim().toLowerCase().replace(/[\s_-]+/g, '').slice(0, 16) || null
    }),

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

  /**
   * 反復。親の曲線に沿って n 個並べる。
   *
   * 上限 32 は実測から。向日葵の紋は花弁 26 枚、縄の輪の撚りは数十本あり、
   * 24 では足りなかった。32 枚のヴェシカは 64 シェイプになるので、
   * DSL の上限（96）と釣り合う。
   */
  count: num(1, 32, 1).transform((v) => Math.round(v)),
  /** 反復を散らす角度の幅。0 なら同心に外へ重ねる */
  spread: num(0, 340, 0),
  /** 同心反復の間隔（ペン幅に対する比）。2 なら線 1 本ぶんの隙間があく */
  pitch: num(1, 8, 2),
  /** 反復の端で size を何倍にするか（1 で一定） */
  taper: num(0.2, 2, 1),
  /**
   * vesica 専用。長さ ÷ 幅。1.4 が既定（ほぼ木の葉）、4 以上で細い花弁になる。
   *
   * 以前は 2 円のずれ量を比例体系から決めていたので、細長さが 1.38:1 に固定
   * されていた。向日葵や桜の花弁は実物で 4:1 前後あり、固定のままでは
   * どの花弁も豆になる。
   */
  slender: num(1, 8, 1.4),
  /** limb 専用。先端の半径が付け根の何倍か（1 で一定太さ） */
  tip: num(0.05, 1, 0.4),
  /** limb 専用。長さが付け根の半径の何倍か */
  length: num(1.2, 12, 3),
  /**
   * 白の縁取り（キーライン）の幅。ペン幅の何倍か。0 で無し。
   *
   * 重なった部品を一定幅の白で分ける。翼と胴、首と胸、花弁と円板——
   * 洗練された紋章ロゴが例外なく持っている操作で、**これが無いと部品が
   * 黒い塊へ溶ける**。層（layers）の白は同心にしか置けず、幅も半径に比例して
   * ばらつくので、重なりを分ける用には使えない。
   */
  outline: num(0, 4, 0),

  mirror: flag,
})

export type FigureNode = z.infer<typeof figureNodeSchema>

/**
 * 鏡像として複製された節点。
 *
 * 「どこに」の反転は、展開時ではなく配置時に行う。親が円なら角度を折り返すが、
 * 親が線なら軸上の位置なのでそのまま——親の形が分からないと決められない。
 * 展開時に角度の規則を当てていたため、棒に付いた目が反対側へ飛んでいた
 *（実測: カタツムリの目の対が 107% ずれた）。
 */
type Expanded = FigureNode & { flip?: boolean }

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
  /**
   * 選んだ構図の定石。
   *
   * 幾何には使わない。モデルが「先に骨組みを選ぶ」ことを守ったかを、
   * 出力から確かめられるようにするために受け取る。書かせること自体が
   * 効いていて、書かせないと骨組みを飛ばして特徴だけ並べる。
   */
  pose: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 16) : '')),
  nodes: z.array(figureNodeSchema).min(1).max(40),
})

/**
 * 生成のときモデルへ渡すスキーマ。
 *
 * figureSchema はほとんどの欄を number | string | null の union にしてある。
 * 弱いモデルが返す揺れ（数を文字列で返す、空欄に null を入れる）を吸収して
 * 再試行の費用を避けるためで、これは実測で効いている。
 *
 * ところが Anthropic の構造化出力は union 型の欄数に上限があり（16）、
 * 23 個で弾かれる。**頼むときは素直な型で頼み、受けるときは緩く受ける。**
 * 素直な型のほうが、モデルにとっても仕様書として読みやすい。
 *
 * 欄の名前は figureSchema と同じなので、出力はそのまま通せる。
 */
const layerName = z.enum(['ink', 'paper'])

export const figureRequestSchema = z.object({
  name: z.string(),
  concept: z.string(),
  pose: z.string().optional(),
  ratio: z.enum(['golden', 'silver', 'integer']).optional(),
  pen: z.enum(['thin', 'regular', 'bold']).optional(),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        form: z.enum(FIGURE_FORMS).optional(),
        on: z.string().optional(),
        grip: z.enum(GRIPS).optional(),
        // 方角の言葉と角度の両方を受けるので、ここだけは union が要る
        at: z.union([z.number(), z.string()]).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        size: z.number().optional(),
        angle: z.number().optional(),
        span: z.number().optional(),
        layers: z.array(layerName).optional(),
        count: z.number().optional(),
        spread: z.number().optional(),
        pitch: z.number().optional(),
        taper: z.number().optional(),
        slender: z.number().optional(),
        tip: z.number().optional(),
        length: z.number().optional(),
        outline: z.number().optional(),
        mirror: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(40),
})

export type Figure = z.infer<typeof figureSchema>
export type FigurePlan = Figure & { palette?: LogoDesign['palette'] }

const round = (v: number) => Math.round(v * 1000) / 1000
const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * 方角の言葉を角度へ。y は下向きなので、上が -90 になる。
 *
 * ここを数だけにしていたとき、「頭は胴の上」を +90 と書いて頭が下に付く
 * 出力が繰り返し出た。符号を覚えなくても書ける口を用意しておく。
 */
const COMPASS: Record<string, number> = {
  right: 0, e: 0, 右: 0,
  downright: 45, se: 45, 右下: 45,
  down: 90, s: 90, bottom: 90, below: 90, 下: 90,
  downleft: 135, sw: 135, 左下: 135,
  left: 180, w: 180, 左: 180,
  upleft: -135, nw: -135, 左上: -135,
  up: -90, n: -90, top: -90, above: -90, 上: -90,
  upright: -45, ne: -45, 右上: -45,
}

/** 線に沿った位置の言葉。始点 -50、中央 0、終点 50。 */
const ALONG: Record<string, number> = {
  start: -50, head: -50, front: -50, first: -50, 先: -50, 始: -50,
  middle: 0, center: 0, mid: 0, 中: 0,
  end: 50, tail: 50, back: 50, last: 50, 末: 50, 終: 50,
}

/**
 * 鏡像側の「どこに」。
 *
 * 円を親にしたときだけ折り返す（角度を 180 から引く）。線を親にしたときは
 * 軸上の位置なので、親そのものが反転している以上そのままでよい。
 */
function flipIf(flip: boolean | undefined, at: number | null, curved: boolean): number | null {
  if (!flip || curved || at === null) return at
  return 180 - at
}

/** at を角度／位置の数に直す。読めない語は既定へ倒す（却下しない）。 */
function resolveAt(at: number | string | null, curved: boolean): number | null {
  if (typeof at === 'number') return at
  if (at === null) return null
  const table = curved ? ALONG : COMPASS
  if (at in table) return table[at]
  // 取り違えても意味は近いので、もう一方の表も見る
  const other = curved ? COMPASS : ALONG
  return at in other ? other[at] : null
}

function ladderStep(ratio: Figure['ratio']): number {
  return ratio === 'silver' ? Math.SQRT2 : ratio === 'integer' ? 1.5 : PHI
}

/**
 * ペン幅。外接半径に対する比で決める。
 *
 * 家紋 390 点の実測は 0.10 / 0.17 / 0.25 だが、**そのまま使うと壊れる**。
 * 試したところ、魚の骨の肋骨が 1 本の帯に溶け、トリケラトプスの棘が消え、
 * 頂点 62 → 35 / 角 52 → 20 と articulation が半減した。
 *
 * 家紋は 5〜10 要素で、こちらは 20〜40 要素ある。ペンをマーク全体の外接半径に
 * 対して決める以上、要素が増えれば同じ比では太すぎる。実測の定数は要素密度ごと
 * 別物で、そのまま移せない。既定は実測の約半分に留める。
 */
function penWidth(reach: number, pen: Figure['pen']): number {
  const k = pen === 'thin' ? 0.055 : pen === 'bold' ? 0.13 : 0.085
  return round(Math.max(reach * k, 0.04))
}

type Placed = {
  node: Expanded
  /** 宣言された順。演算の順序はこれで決める */
  seq: number
  /** 反復した 1 個ぶんの位置と向きと寸法、そして実際に使われた置き方 */
  copies: Array<{
    x: number
    y: number
    angle: number
    size: number
    grip: GripId
    /** 混み合いを避けて外へ広げた量。0 でなければ宣言した関係から外れている */
    spun?: number
  }>
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
  host: { x: number; y: number; size: number; angle: number; span: number; form: FigureFormId },
  t: number,
  at: number | null,
  spread: number,
): { x: number; y: number; normal: number } {
  // t は -0.5 〜 0.5
  if (host.form === 'bar') {
    // 軸に沿って。at は軸上の位置（割合）、spread は使う範囲の割合
    const use = spread > 0 ? Math.min(spread / 340, 1) : 1
    const base = Math.min(0.5, Math.max(-0.5, (at ?? 0) / 100))
    const d = (base + t * use) * 2 * host.size
    const c = Math.cos(rad(host.angle))
    const s = Math.sin(rad(host.angle))
    return { x: host.x + c * d, y: host.y + s * d, normal: host.angle + 90 }
  }
  if (host.form === 'arc') {
    // 弧の開き角の内側に収める。at は弧上の位置（割合）
    const use = spread > 0 ? Math.min(spread, host.span) : host.span
    const base = Math.min(0.5, Math.max(-0.5, (at ?? 0) / 100))
    const a = host.angle + base * host.span + t * use
    return {
      x: host.x + Math.cos(rad(a)) * host.size,
      y: host.y + Math.sin(rad(a)) * host.size,
      normal: a,
    }
  }
  const a = (at ?? -90) + t * spread
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
export function placeNodes(nodes: Expanded[], pen: number): Placed[] {
  const byId = new Map<string, Expanded>()
  nodes.forEach((n, i) => byId.set(n.id || `n${i}`, n))

  const done = new Map<string, Placed>()
  const order: Placed[] = []
  const pending = nodes.map((n, i) => ({ n, key: n.id || `n${i}`, seq: i }))

  for (let pass = 0; pass < nodes.length + 1 && pending.length > 0; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const { n, key, seq } = pending[i]
      const host = n.on && byId.has(n.on) && n.on !== key ? done.get(n.on) : undefined
      if (n.on && n.on !== key && byId.has(n.on) && !host) continue // 親がまだ

      const copies: Placed['copies'] = []
      const count = Math.max(1, n.count)

      if (!host) {
        // 親なし。絶対座標に置く
        const facing = flipIf(n.flip, resolveAt(n.at, false), false)
        for (let k = 0; k < count; k++) {
          const t = count === 1 ? 0 : k / (count - 1) - 0.5
          copies.push({
            x: round(n.x),
            y: round(n.y),
            angle: n.angle ?? facing ?? -90,
            size: round(n.size * taperAt(n.taper, t)),
            grip: n.grip,
          })
        }
      } else {
        // 反復する親（肋骨のような）の中央を基準にする
        const h = host.copies[Math.floor(host.copies.length / 2)]
        const hostForm = host.node.form
        const curved = hostForm === 'bar' || hostForm === 'arc'
        // 親の形が決まってはじめて「どこに」が読める。円なら方角、線なら位置。
        // 鏡像の折り返しも、ここまで来ないと正しく決められない
        const at = flipIf(n.flip, resolveAt(n.at, curved), curved)

        // 全周に配るときは、両端が同じ位置に来ないよう刻みを 1 つ増やす。
        // 330° 以上を「一周」と見なす（実測: spread 360 / count 3 と書かれると、
        // -180 と +180 が重なって 2 箇所にしか出なかった）。
        const wraps = !curved && n.spread >= 330 && count > 1
        // 反復した個体どうしが食い合うと、律動が消えて 1 つの塊になる。
        // 隣どうしの間隔が半径の 1.6 倍を切るなら**寸法を縮めて**噛み合わせる。
        //
        // 以前は軌道を外へ広げていたが、それだと親から離れて宙に浮いた
        //（実測: 円板 2.4 に花弁 24 枚を外接させたら軌道が 4.9 まで飛び、
        // 花弁の環と円板が別々の島になった）。花弁の多い紋は実物でも花弁が
        // 細く小さいので、縮めるほうが合う。
        // 逃がし方は、子と親のどちらが主役かで変わる。
        //   子 > 親 … 花弁が主役（三つ葉・桜・梅）。軌道を外へ広げる
        //   子 < 親 … 円板が主役（向日葵）。花弁を縮める
        // 逆にすると、三つ葉が芯に埋まって丸になり、向日葵の花弁が円板から
        // 離れて別々の島になった（どちらも実測）。
        const stepDeg = wraps ? 360 / count : count > 1 ? n.spread / (count - 1) : 0
        const bite = biteFor(n.outline)
        const baseOrbit = curved ? h.size : gripOffset(n.grip, h.size, n.size, pen, bite)
        let orbit = baseOrbit
        let shrink = 1
        if (!curved && count > 1 && stepDeg > 0) {
          const chord = 2 * baseOrbit * Math.sin(rad(stepDeg) / 2)
          const want = n.size * 1.6
          if (chord < want && chord > 0) {
            if (n.size > h.size) orbit = want / (2 * Math.sin(rad(stepDeg) / 2))
            else shrink = chord / want
          }
        }
        const spun = round(orbit - baseOrbit)

        for (let k = 0; k < count; k++) {
          const t = wraps ? k / count : count === 1 ? 0 : k / (count - 1) - 0.5
          const size = round(n.size * taperAt(n.taper, t) * shrink)

          // 散らさない反復は同心に外へ重ねる（音の輪・波紋）
          if (n.spread === 0 && count > 1 && !curved) {
            const gap = n.pitch * pen
            copies.push({
              x: h.x,
              y: h.y,
              angle: n.angle ?? at ?? -90,
              size: round(n.size + k * gap),
              grip: 'center',
            })
            continue
          }

          // 同心はそのままの半径で置く。かつて「親に触れるまで縮める」修復を
          // 入れたが、囲い・フリル・冠羽・ヘッドホンのバンドがことごとく親に
          // 飲まれて消えた（実測: バンドは size 2.35 → r 2.06 になり、頭 r 2.1
          // からの出っぱりが 0.15 しか残らなかった）。
          // そもそも囲いは触れていないのが正しい——家紋の「丸に三つ葉」の丸は
          // 葉に触れていない。離れていること自体は咎めない。
          if (n.grip === 'center' && !curved && !(count > 1 && n.spread > 0)) {
            copies.push({
              x: h.x,
              y: h.y,
              angle: n.angle ?? at ?? -90,
              size,
              grip: 'center',
            })
            continue
          }

          const p = alongHost(
            { x: h.x, y: h.y, size: h.size, angle: h.angle, span: host.node.span, form: hostForm },
            t,
            at,
            wraps ? 360 : n.spread,
          )
          // 円を親にしたときは中心からの距離で、線を親にしたときは法線方向の
          // ずらしで置く。どちらも「触れている位置」を関係が決める
          // 親より大きい子を外接で付けると、1 点でしか触れず別の塊に見える
          //（実測: 頭に外接する大きな環が、宙に浮いた輪として読めた）。
          // 中心を親の輪郭に乗せる関係へ倒すと、深く重なって 1 つの塊になる。
          const grip = n.grip === 'outside' && size > h.size ? 'on' : n.grip
          const off = curved ? offsetAlongNormal(grip, size, pen, bite) : 0
          const dist = curved ? 0 : gripOffset(grip, h.size, size, pen, bite) - h.size + spun
          const c = Math.cos(rad(p.normal))
          const s = Math.sin(rad(p.normal))
          copies.push({
            x: round(p.x + c * (dist + off)),
            y: round(p.y + s * (dist + off)),
            angle: n.angle ?? p.normal,
            size,
            grip,
            spun,
          })
        }
      }

      const placed: Placed = { node: n, seq, copies, host: host ? (n.on ?? null) : null }
      done.set(key, placed)
      order.push(placed)
      pending.splice(i, 1)
    }
  }
  // 解けなかったものは絶対座標で置く
  for (const { n, seq } of pending) {
    order.push({
      node: n,
      seq,
      copies: [
        {
          x: n.x,
          y: n.y,
          angle: n.angle ?? flipIf(n.flip, resolveAt(n.at, false), false) ?? -90,
          size: n.size,
          grip: n.grip,
        },
      ],
      host: null,
    })
  }
  return order
}

/**
 * 太さの違う 2 円の外接接線がつくる四辺形。
 *
 * 片方がもう片方を含むときは胴が要らない（大きいほうで足りる）ので null。
 */
function tangentQuad(
  a: { x: number; y: number; r: number },
  b: { x: number; y: number; r: number },
): Array<{ x: number; y: number }> | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9 || Math.abs(a.r - b.r) >= d) return null
  const ux = dx / d
  const uy = dy / d
  const theta = Math.acos(Math.max(-1, Math.min(1, (a.r - b.r) / d)))
  const at = (c: { x: number; y: number; r: number }, sign: number) => {
    const s = Math.sin(theta) * sign
    const co = Math.cos(theta)
    return { x: round(c.x + c.r * (ux * co - uy * s)), y: round(c.y + c.r * (ux * s + uy * co)) }
  }
  return [at(a, 1), at(b, 1), at(b, -1), at(a, -1)]
}

/** 反復の端で寸法を変える係数 */
function taperAt(taper: number, t: number): number {
  // t は -0.5（先頭）〜 0.5（末尾）。中央を 1 とし、端で taper へ寄せる
  return 1 + (taper - 1) * Math.abs(t) * 2
}

/** 線を親にしたときの、法線方向へのずらし量 */
function offsetAlongNormal(grip: GripId, ownR: number, pen: number, bite: number): number {
  switch (grip) {
    case 'outside':
      return ownR - pen * bite
    case 'inside':
      return -ownR + pen * bite
    default:
      return 0
  }
}

/**
 * 外接・内接で食い込ませる量（ペン幅に対する比）。
 *
 * 幾何としての接は 1 点でしか触れない。円どうしなら画素では繋がるが、弧や棒に
 * 接するものは離れたまま残る（実測: 食い込ませないと、鳥と骨格で 4% ほどの島が
 * 1 つずつ切り離された）。ロゴとしても、拡大すると輪郭が一点でくびれる欠陥になる。
 * 線 1 本ぶん食い込ませれば、作図としては接したまま、墨としては必ず繋がる。
 *
 * 白の縁取り（outline）を持つ節点は、縁取りのぶんだけ深く食い込ませる。
 * そうしないと縁取りが接点ごと削り取って部品が切り離される
 *（実測: 縁取り 1.0 を入れたら嘴と尾が本体から外れた）。
 */
const BITE = 0.6
const biteFor = (outline: number) => Math.max(BITE, outline + 0.6)

/** 親の中心からの距離。置き方がそのまま距離を決める。 */
function gripOffset(grip: GripId, hostR: number, ownR: number, pen: number, bite: number): number {
  switch (grip) {
    case 'outside':
      return hostR + ownR - pen * bite
    case 'inside':
      return Math.max(hostR - ownR + pen * bite, 0)
    case 'center':
      return 0
    default:
      return hostR
  }
}

/**
 * 制約が指せるシェイプ id。
 *
 * 制約は「中心を持つシェイプ」にしか張れない。棒は中心を持たない。
 *
 * ヴェシカと四肢は複数の円の合成で、**片方の円にだけ制約を張ると
 * ソルバーがそれを引き剥がす**。実測: 花弁 24 枚を円板に外接させたところ、
 * 片方の円だけが親へ引き寄せられて 2 円が離れ、交差が空になって
 * 花弁が 24 枚とも消えた。合成形には張らない。
 *
 * 制約を張れないぶん設計図に関係線は出ないが、位置は figure.ts が関係から
 * 導いているので幾何は正しい。ソルバーに解かせる必要がそもそも無い。
 */
function anchorOf(form: FigureFormId, id: string): string | null {
  if (form === 'bar' || form === 'vesica' || form === 'limb') return null
  return id
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
  form: FigureFormId,
  id: string,
  c: { x: number; y: number; angle: number; size: number },
  r0: number,
  pen: number,
  span: number,
  tip = 0.4,
  length = 3,
  slender = 1.4,
  /** 白の縁取りを作るために、全方向へこれだけ太らせた版を出す */
  grow = 0,
): { shapes: Shape[]; ref: string } {
  const r = round(r0 + grow)
  switch (form) {
    case 'ring':
      return {
        shapes: [
          { kind: 'ring', id, cx: c.x, cy: c.y, r, w: round(Math.min(pen + grow * 2, r * 0.8)) },
        ],
        ref: id,
      }
    case 'arc': {
      // 端にも縁取りが要るので、太らせるぶんだけ開き角も広げる
      const ext = grow > 0 ? (grow / Math.max(r, 1e-6)) * (180 / Math.PI) : 0
      return {
        shapes: [
          {
            kind: 'arc',
            id,
            cx: c.x,
            cy: c.y,
            r: round(r0),
            w: round(Math.min(pen + grow * 2, r * 1.2)),
            a0: round(c.angle - span / 2 - ext),
            a1: round(c.angle + span / 2 + ext),
            cap: 'butt',
          },
        ],
        ref: id,
      }
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
            w: round(pen + grow * 2),
            cap: 'butt',
          },
        ],
        ref: id,
      }
    case 'limb': {
      // 太さの違う 2 円を外接接線で包む。円と直線だけでテーパーが出る
      const tipR = round(Math.max(r0 * tip, pen * 0.35) + grow)
      const far = round(r0 * length)
      const bx = round(c.x + Math.cos(rad(c.angle)) * far)
      const by = round(c.y + Math.sin(rad(c.angle)) * far)
      const shapes: Shape[] = [
        { kind: 'circle', id: `${id}a`, cx: c.x, cy: c.y, r },
        { kind: 'circle', id: `${id}b`, cx: bx, cy: by, r: tipR },
      ]
      const hull = tangentQuad({ x: c.x, y: c.y, r }, { x: bx, y: by, r: tipR })
      if (hull) shapes.push({ kind: 'poly', id: `${id}c`, points: hull })
      return { shapes, ref: `${id}G` }
    }

    case 'vesica': {
      // 2 円の交差。size は半分の長さで、slender が長さ ÷ 幅を決める。
      //
      //   L = 半分の長さ = size、W = 半分の幅 = L / slender
      //   2 円の半径 R と中心のずれ d は L² = R² − d²、W = R − d から出る
      //
      // 生成円の半径を size とする書き方だと、細長さが 1.38:1 に固定される。
      const L = Math.max(r, 1e-6)
      const W = Math.max(L / slender, pen * 0.3)
      const R = round((L * L + W * W) / (2 * W))
      const d = round(R - W)
      const nx = -Math.sin(rad(c.angle))
      const ny = Math.cos(rad(c.angle))
      return {
        shapes: [
          { kind: 'circle', id: `${id}a`, cx: round(c.x - nx * d), cy: round(c.y - ny * d), r: R },
          { kind: 'circle', id: `${id}b`, cx: round(c.x + nx * d), cy: round(c.y + ny * d), r: R },
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
  const expanded: Expanded[] = []
  for (const n of parsed.nodes) {
    expanded.push(n)
    if (n.mirror) {
      expanded.push({
        ...n,
        id: `${n.id}M`,
        // 親も鏡像側を見る（親が軸上なら元のまま）
        on: n.on && parsed.nodes.some((m) => m.id === n.on && m.mirror) ? `${n.on}M` : n.on,
        x: -n.x,
        angle: n.angle === null ? null : 180 - n.angle,
        flip: true,
      })
    }
  }

  // ペン幅は図の大きさから決まり、図の大きさは同心反復の間隔（ペン幅の倍数）に
  // 依存する。相互に依存するので、仮のペンで一度置いて測り、決まったペンで
  // 置き直す。1 往復で十分収束する（間隔がペンに比例するだけなので）。
  const reachOf = (ps: Placed[]) =>
    Math.max(...ps.flatMap((p) => p.copies.map((c) => Math.hypot(c.x, c.y) + c.size)), 1)
  const rough = Math.max(...expanded.map((n) => n.size), 1) * 1.6
  const pen = penWidth(reachOf(placeNodes(expanded, penWidth(rough, parsed.pen))), parsed.pen)
  // 依存を解くために順不同で置いたものを、宣言順へ戻す。
  //
  // 解決ループは「親が解けたものから」詰めるので、同じ深さの兄弟が逆順に
  // 並び、節点をまたいだ入れ子（白を敷いてから墨を置く）が成立しなかった
  //（実測: 胴・白・腕 と宣言した図で steps が add:body add:arm sub:gap になり、
  // 後から来た白が腕を丸ごと消した）。座標はそのまま、演算の順だけを直す。
  const placed = placeNodes(expanded, pen).sort((a, b) => a.seq - b.seq)
  const stepDown = ladderStep(parsed.ratio)

  const shapes: Shape[] = []
  const groups: LogoDesign['groups'] = []
  const steps: Step[] = []
  const constraints: Constraint[] = []
  const radiusOf = new Map<string, number>()

  placed.forEach((p, i) => {
    const base = p.node.id || `n${i}`
    // 白の縁取りは「下にあるものから分ける」ためのもので、自分の兄弟を切って
    // はいけない。1 つずつ「抜いて置く」を繰り返すと、隣り合うコピーが互いの
    // 縁取りで削り合い、楔形の屑が残る（実測: 花弁 5 枚を 340° に詰めて
    // 縁取りを付けたら、島が 1 → 6、角が 5 → 20 になった）。
    // 節点の中では、抜きを全部先に済ませてから置く。
    const cuts: Step[] = []
    const inks: Step[] = []
    p.copies.forEach((c, k) => {
      const tag = p.copies.length > 1 ? `${base}_${k}` : base
      p.node.layers.forEach((layer, li) => {
        const r = round(c.size / stepDown ** li)
        if (r < pen * 0.35) return // 層が細くなりすぎたら置かない
        const id = li === 0 ? tag : `${tag}L${li}`
        const emit = (shapeId: string, grow: number) => {
          const out = shapeFor(
            p.node.form,
            shapeId,
            c,
            r,
            pen,
            p.node.span,
            p.node.tip,
            p.node.length,
            p.node.slender,
            grow,
          )
          shapes.push(...out.shapes)
          if (out.ref.endsWith('G')) {
            groups.push({
              id: out.ref,
              steps:
                p.node.form === 'limb'
                  ? out.shapes.map((sh) => ({ op: 'add' as const, ref: sh.id }))
                  : [
                      { op: 'add', ref: `${shapeId}a` },
                      { op: 'intersect', ref: `${shapeId}b` },
                    ],
            })
          }
          return out.ref
        }

        // 白の縁取り。太らせた同じ形を先に抜いてから本体を置くと、重なった
        // 相手との境目に一定幅の白が残る。順序が宣言順になっている前提。
        if (li === 0 && layer === 'ink' && p.node.outline > 0) {
          cuts.push({ op: 'sub', ref: emit(`${id}O`, round(p.node.outline * pen)) })
        }
        const ref = emit(id, 0)
        inks.push({ op: layer === 'paper' ? 'sub' : 'add', ref })
        if (li === 0) radiusOf.set(id, r)
        // 層どうしは同心。これを宣言しておくと設計図に関係が出る
        if (li > 0 && anchorOf(p.node.form, id) && anchorOf(p.node.form, tag)) {
          constraints.push({
            type: 'concentric',
            a: anchorOf(p.node.form, id) as string,
            b: anchorOf(p.node.form, tag) as string,
          })
        }
      })
      // 親との関係。反復した個体それぞれに張る。
      //
      // 混み合いを避けて軌道を外へ広げた個体には張らない。宣言した関係
      //（外接・円周上）を幾何が満たしていないので、張るとソルバーが
      // 引き戻してしまい、せっかく散らした配置が潰れる。
      const hostPlaced = p.host ? placed.find((q) => (q.node.id || '') === p.host) : undefined
      const self = c.spun ? null : anchorOf(p.node.form, tag)
      if (hostPlaced && self && radiusOf.has(tag)) {
        const hostTag =
          hostPlaced.copies.length > 1
            ? `${p.host}_${Math.min(k, hostPlaced.copies.length - 1)}`
            : (p.host as string)
        const hostAnchor = anchorOf(hostPlaced.node.form, hostTag)
        if (hostAnchor && radiusOf.has(hostTag)) {
          const c2 = constraintFor(c.grip, self, hostAnchor)
          if (c2) constraints.push(c2)
        }
      }
    })
    steps.push(...cuts, ...inks)
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
