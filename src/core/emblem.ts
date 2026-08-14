import { z } from 'zod'
import type { LogoDesign, Shape, Step } from './dsl'
import { PHI } from './units'

/**
 * 同心円の族による面構成。
 *
 * 家紋を逆算して分かったことを、順方向の作図に戻したもの。逆算では
 * 次の 3 つが繰り返し現れた。
 *
 *   - 語彙は円・円弧・直線しか要らない（楕円も自由曲線も一度も要らなかった）
 *   - 半径の種類が極端に少ない（人が作図した紋は 3〜5 種、
 *     有機的なシルエットをトレースすると 10〜14 種に散る）
 *   - 対称は「形の性質」ではなく「作図の順序」。片側を引いて反転する
 *
 * ここでは寸法をすべて 1 本の比例階梯から取る。半径は base × k^n しか
 * 存在しないので、体系に載っていることが構成上保証される。外から寄せる
 * のではなく、最初から階梯の上でしか作図できない。
 *
 * 位置も同じ階梯の刻みで指定する。目・耳・肩のように対になるものは
 * 片側だけ置いて反転する。
 */

export const RATIOS = ['golden', 'silver', 'integer'] as const
export type Ratio = (typeof RATIOS)[number]

/** 階梯の倍率。1 段上がるとこの倍になる。 */
export function ladderStep(ratio: Ratio): number {
  switch (ratio) {
    case 'golden':
      return PHI
    case 'silver':
      return Math.SQRT2
    case 'integer':
      return 1.5
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000

/** 階梯の n 段目の寸法 */
export const ladder = (base: number, ratio: Ratio, n: number): number =>
  round(base * ladderStep(ratio) ** n)

const num = (min: number, max: number, fallback: number) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : v
      if (n === undefined || n === null || !Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.round(n)))
    })

/**
 * 同心の輪 1 枚。
 *
 * step は階梯の段。外側から順に置き、塗りと抜きが交互になるのではなく
 * 明示する（目のように「輪・白・瞳」と 3 枚重なる構成があるため）。
 */
export const ringSchema = z.object({
  step: num(-4, 5, 0),
  hole: z
    .union([z.boolean(), z.string(), z.null()])
    .optional()
    .transform((v) => v === true || v === 'true'),
})

/**
 * 節点。1 つの中心に同心の輪を重ねたもの。
 *
 * 顔でいえば「目」「マズル」「耳」がそれぞれ 1 節点になる。
 */
export const nodeSchema = z.object({
  label: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v ?? '').slice(0, 24)),
  /** 位置は階梯の刻み（base の何倍か）で与える */
  x: num(-8, 8, 0),
  y: num(-8, 8, 0),
  rings: z.array(ringSchema).min(1).max(5),
  /** 対になるものは片側だけ置いて反転する */
  mirror: z
    .union([z.boolean(), z.string(), z.null()])
    .optional()
    .transform((v) => v === true || v === 'true'),
})

export const emblemSchema = z.object({
  name: z.string().min(1).max(40),
  concept: z.string().min(1).max(600),
  ratio: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return k === 'silver' || k === 'integer' ? (k as Ratio) : ('golden' as const)
    }),
  nodes: z.array(nodeSchema).min(1).max(10),
})

export type Emblem = z.infer<typeof emblemSchema>
export type EmblemNode = z.infer<typeof nodeSchema>

/** 位置の刻み。半径の階梯と揃えると位置と寸法が同じ体系に載る。 */
const GRID = 0.5

/** 基準半径。すべての寸法はここから階梯で導く。 */
const BASE = 1

/**
 * 対になる節点を展開する。
 *
 * 反転をコードで行うので、位置も半径も厳密に鏡像になる。モデルに 2 つ
 * 書かせると必ず食い違う（トレースの計測でも、左右を独立に当てはめると
 * 鏡像一致が 34% まで落ちた）。
 */
function expand(nodes: EmblemNode[]): EmblemNode[] {
  const out: EmblemNode[] = []
  for (const n of nodes) {
    out.push(n)
    // 軸上の節点を反転しても同じ位置に重なるだけ
    if (n.mirror && n.x !== 0) out.push({ ...n, x: -n.x })
  }
  return out
}

export type EmblemPlan = Emblem & { palette?: LogoDesign['palette'] }

/**
 * 節点の並びから LogoDesign を組み立てる。
 *
 * モデルが決めるのは「どこに」「何段の輪を」「いくつ重ねるか」だけ。
 * 半径は階梯からしか選べず、対称は構成で保証され、演算の順序は
 * 外側から内側へと決まっている。作図が壊れる余地がない。
 */
export function buildFromEmblem(plan: EmblemPlan): LogoDesign {
  const parsed = emblemSchema.parse(plan)
  const nodes = expand(parsed.nodes)

  const shapes: Shape[] = []
  const steps: Step[] = []

  nodes.forEach((node, i) => {
    const cx = round(node.x * GRID)
    const cy = round(node.y * GRID)

    // 外側から内側へ。輪は必ず大きい順に置く（内から置くと外の輪が上書きする）
    const rings = [...node.rings]
      .map((r) => ({ ...r, radius: ladder(BASE, parsed.ratio, r.step) }))
      .sort((a, b) => b.radius - a.radius)

    rings.forEach((ring, j) => {
      const id = `n${i}r${j}`
      shapes.push({ kind: 'circle', id, cx, cy, r: ring.radius })
      steps.push({ op: ring.hole ? 'sub' : 'add', ref: id })
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
    constraints: [],
    groups: [],
    parts: [{ id: 'mark', steps, fill: 'primary', mirror: 'none' }],
  }
}

/** 設計に現れる半径の種類数。体系に載っているかの指標。 */
export function distinctRadii(design: LogoDesign): number {
  const rs = design.shapes
    .map((s) => ('r' in s ? s.r : null))
    .filter((r): r is number => r !== null)
    .map((r) => Math.round(r * 1000))
  return new Set(rs).size
}
