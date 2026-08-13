import { z } from 'zod'

/**
 * 幾何ロゴ DSL。
 *
 * 座標系
 *  - 単位は「モジュール」。1 モジュール = レンダリング時の `module` px。
 *  - 原点 (0,0) は構成の中心。y 軸は下向き（SVG 準拠）。
 *  - 角度は度数法、0° = 右方向 (+x)、正の向きは時計回り（SVG 準拠）。
 *
 * 設計方針
 *  - 再帰スキーマは structured output で扱えないため、組み立ては
 *    「プリミティブ → group（1段）→ part」の逐次ステップに平坦化している。
 */

const id = z.string().min(1).describe('一意な識別子（例: c1, bar2）')

export const circleSchema = z.object({
  kind: z.literal('circle'),
  id,
  cx: z.number(),
  cy: z.number(),
  r: z.number().positive(),
  pinned: z.boolean().optional().describe('true なら中心座標を一切動かさない（スナップも制約解決も対象外）'),
})

export const ringSchema = z.object({
  kind: z.literal('ring'),
  id,
  cx: z.number(),
  cy: z.number(),
  r: z.number().positive().describe('外周半径'),
  w: z.number().positive().describe('線幅（外周から内側へ）'),
  pinned: z.boolean().optional(),
})

export const barSchema = z.object({
  kind: z.literal('bar'),
  id,
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  w: z.number().positive().describe('太さ'),
  cap: z.enum(['butt', 'round']).default('butt'),
  fromRef: z.string().optional().describe('始点を他シェイプの中心に束縛（制約解決後に反映）'),
  toRef: z.string().optional().describe('終点を他シェイプの中心に束縛'),
})

export const rectSchema = z.object({
  kind: z.literal('rect'),
  id,
  cx: z.number(),
  cy: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  radius: z.number().min(0).optional().describe('角丸半径'),
  rotate: z.number().optional().describe('中心まわりの回転角（度）'),
  pinned: z.boolean().optional(),
})

export const wedgeSchema = z.object({
  kind: z.literal('wedge'),
  id,
  cx: z.number(),
  cy: z.number(),
  r: z.number().positive(),
  a0: z.number().describe('開始角（度）'),
  a1: z.number().describe('終了角（度）。a0 < a1'),
  pinned: z.boolean().optional(),
})

export const polySchema = z.object({
  kind: z.literal('poly'),
  id,
  // タプルではなくオブジェクト配列。JSON Schema の `items: [..]` 形は
  // structured output で拒否されることがあるため。
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
})

export const shapeSchema = z.discriminatedUnion('kind', [
  circleSchema,
  ringSchema,
  barSchema,
  rectSchema,
  wedgeSchema,
  polySchema,
])

export const constraintSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tangent'),
    a: z.string(),
    b: z.string(),
    mode: z.enum(['external', 'internal']).default('external'),
  }).describe('2 円を接する位置に補正する'),
  z.object({ type: z.literal('concentric'), a: z.string(), b: z.string() }),
  z.object({ type: z.literal('align'), ids: z.array(z.string()).min(2), axis: z.enum(['x', 'y']) })
    .describe('axis:"x" は cx を揃える（＝縦一直線に並ぶ）'),
  z.object({ type: z.literal('onCircle'), point: z.string(), circle: z.string() })
    .describe('point の中心を circle の円周上に乗せる'),
])

export const stepSchema = z.object({
  op: z.enum(['add', 'sub', 'intersect']),
  ref: z.string().describe('シェイプ id、または group id'),
})

export const groupSchema = z.object({
  id,
  steps: z.array(stepSchema).min(1),
})

export const partSchema = z.object({
  id,
  steps: z.array(stepSchema).min(1),
  fill: z.enum(['primary', 'secondary', 'accent']).default('primary'),
  mirror: z.enum(['none', 'vertical', 'horizontal']).default('none')
    .describe('vertical は x=0 を軸に左右対称化（半分だけ描いて反転できる）'),
})

export const designSchema = z.object({
  name: z.string(),
  concept: z.string().describe('設計意図を 1〜3 文で'),
  module: z.number().positive().default(64).describe('1 モジュールの px 値'),
  grid: z.enum(['golden', 'sqrt2', 'square', 'isometric']).default('golden'),
  palette: z.object({
    primary: z.string().default('#111111'),
    secondary: z.string().default('#8A8A8A'),
    accent: z.string().default('#C2410C'),
    background: z.string().default('#FFFFFF'),
  }).default({
    primary: '#111111',
    secondary: '#8A8A8A',
    accent: '#C2410C',
    background: '#FFFFFF',
  }),
  shapes: z.array(shapeSchema).min(1),
  constraints: z.array(constraintSchema).default([]),
  groups: z.array(groupSchema).default([]),
  parts: z.array(partSchema).min(1),
})

export type Circle = z.infer<typeof circleSchema>
export type Ring = z.infer<typeof ringSchema>
export type Bar = z.infer<typeof barSchema>
export type Rect = z.infer<typeof rectSchema>
export type Wedge = z.infer<typeof wedgeSchema>
export type Poly = z.infer<typeof polySchema>
export type Shape = z.infer<typeof shapeSchema>
export type Constraint = z.infer<typeof constraintSchema>
export type Step = z.infer<typeof stepSchema>
export type Group = z.infer<typeof groupSchema>
export type Part = z.infer<typeof partSchema>
export type LogoDesign = z.infer<typeof designSchema>

/** 中心を持つシェイプ（制約ソルバーが動かせる対象） */
export type Centered = Circle | Ring | Rect | Wedge

export function hasCenter(s: Shape): s is Centered {
  return s.kind === 'circle' || s.kind === 'ring' || s.kind === 'rect' || s.kind === 'wedge'
}

/** 制約で使う「半径的な大きさ」。矩形は外接円相当を返す。 */
export function radiusOf(s: Centered): number {
  switch (s.kind) {
    case 'circle':
    case 'ring':
    case 'wedge':
      return s.r
    case 'rect':
      return Math.hypot(s.w, s.h) / 2
  }
}
