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

/**
 * 信頼境界の定義。
 *
 * この DSL は LLM の出力をそのまま受け取り、生成した SVG は
 * dangerouslySetInnerHTML でページへ注入される。静的モードでは同一オリジンの
 * localStorage に API キーが載るため、ここを抜けられると即キー漏洩になる。
 * したがって「markup に到達しうる文字列」は形を限定し、数値は範囲を切る。
 */

/** id は SVG の属性値になるので英数字・ハイフン・アンダースコアのみ */
const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'id は英数字・ハイフン・アンダースコアのみ')
  .describe('一意な識別子（例: c1, bar2）')

/** 参照も id と同じ形でなければならない */
const ref = id

/** 色は 16 進表記のみ。任意文字列を許すと属性から抜け出せる */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, '色は #rgb / #rrggbb 形式のみ')

// 幾何値の上限。モジュール単位なので、この範囲を超える設計は実用上ありえない。
// 上限が無いと NaN / 1e9 のような値でソルバーが発散し、巨大な SVG でブラウザが固まる。
const COORD_LIMIT = 500
const SIZE_LIMIT = 500

const coord = z.number().finite().min(-COORD_LIMIT).max(COORD_LIMIT)
const size = z.number().finite().positive().max(SIZE_LIMIT)
const angle = z.number().finite().min(-1440).max(1440)

export const circleSchema = z.object({
  kind: z.literal('circle'),
  id,
  cx: coord,
  cy: coord,
  r: size,
  pinned: z.boolean().optional().describe('true なら中心座標を一切動かさない（スナップも制約解決も対象外）'),
})

export const ringSchema = z.object({
  kind: z.literal('ring'),
  id,
  cx: coord,
  cy: coord,
  r: size.describe('外周半径'),
  w: size.describe('線幅（外周から内側へ）'),
  pinned: z.boolean().optional(),
})

export const barSchema = z.object({
  kind: z.literal('bar'),
  id,
  x1: coord,
  y1: coord,
  x2: coord,
  y2: coord,
  w: size.describe('太さ'),
  cap: z.enum(['butt', 'round']).default('butt'),
  fromRef: ref.optional().describe('始点を他シェイプの中心に束縛（制約解決後に反映）'),
  toRef: ref.optional().describe('終点を他シェイプの中心に束縛'),
})

export const rectSchema = z.object({
  kind: z.literal('rect'),
  id,
  cx: coord,
  cy: coord,
  w: size,
  h: size,
  radius: z.number().finite().min(0).max(SIZE_LIMIT).optional().describe('角丸半径'),
  rotate: angle.optional().describe('中心まわりの回転角（度）'),
  pinned: z.boolean().optional(),
})

export const wedgeSchema = z.object({
  kind: z.literal('wedge'),
  id,
  cx: coord,
  cy: coord,
  r: size,
  a0: angle.describe('開始角（度）'),
  a1: angle.describe('終了角（度）。a0 < a1'),
  pinned: z.boolean().optional(),
})

export const arcSchema = z.object({
  kind: z.literal('arc'),
  id,
  cx: coord,
  cy: coord,
  r: size.describe('円弧の中心線の半径'),
  w: size.describe('線の太さ（中心線をまたいで内外に w/2 ずつ）'),
  a0: angle.describe('開始角（度）'),
  a1: angle.describe('終了角（度）'),
  cap: z.enum(['butt', 'round']).default('butt'),
  pinned: z.boolean().optional(),
})

export const polySchema = z.object({
  kind: z.literal('poly'),
  id,
  // タプルではなくオブジェクト配列。JSON Schema の `items: [..]` 形は
  // structured output で拒否されることがあるため。
  points: z.array(z.object({ x: coord, y: coord })).min(3).max(64),
})

/**
 * 円弧でできた閉じた輪郭。
 *
 * 円板を union して形を作ると、接合部に必ず凹んだ切れ込みが出る（実測）。
 * 幾何ロゴの輪郭は本来、複数の円弧が接点で切り替わりながら 1 周するもので、
 * 円は「塗る対象」ではなく「輪郭がどの弧を通るかを決める作図線」にすぎない。
 * これはその輪郭そのものを表す。
 *
 * 各セグメントは「1 つ前の点から、半径 r の円弧を描いてこの点まで」を意味する。
 * r を省略すると直線になる。
 */
export const contourSchema = z.object({
  kind: z.literal('contour'),
  id,
  segments: z
    .array(
      z.object({
        x: coord,
        y: coord,
        r: size.optional().describe('この点へ至る円弧の半径。省略で直線'),
        sweep: z.boolean().default(true).describe('true で時計回りに膨らむ'),
      }),
    )
    .min(3)
    .max(64),
})

export const shapeSchema = z.discriminatedUnion('kind', [
  circleSchema,
  ringSchema,
  barSchema,
  rectSchema,
  wedgeSchema,
  arcSchema,
  polySchema,
  contourSchema,
])

export const constraintSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tangent'),
    a: ref,
    b: ref,
    mode: z.enum(['external', 'internal']).default('external'),
  }).describe('2 円を接する位置に補正する'),
  z.object({ type: z.literal('concentric'), a: ref, b: ref }),
  z.object({ type: z.literal('align'), ids: z.array(ref).min(2).max(64), axis: z.enum(['x', 'y']) })
    .describe('axis:"x" は cx を揃える（＝縦一直線に並ぶ）'),
  z.object({ type: z.literal('onCircle'), point: ref, circle: ref })
    .describe('point の中心を circle の円周上に乗せる'),
])

export const stepSchema = z.object({
  op: z.enum(['add', 'sub', 'intersect']),
  ref: ref.describe('シェイプ id、または group id'),
})

export const groupSchema = z.object({
  id,
  steps: z.array(stepSchema).min(1).max(64),
})

export const partSchema = z.object({
  id,
  steps: z.array(stepSchema).min(1).max(96),
  fill: z.enum(['primary', 'secondary', 'accent']).default('primary'),
  mirror: z.enum(['none', 'vertical', 'horizontal']).default('none')
    .describe('vertical は x=0 を軸に左右対称化（半分だけ描いて反転できる）'),
})

// 表示用テキストは SVG の <title> / aria-label に入る。render.ts でエスケープするが、
// 長さも切っておく（巨大文字列でのメモリ圧迫を防ぐ）。
const displayText = z.string().max(400)

export const designSchema = z.object({
  name: displayText,
  concept: z.string().max(2000).describe('設計意図を 1〜3 文で'),
  module: z.number().finite().positive().max(1024).default(64).describe('1 モジュールの px 値'),
  grid: z.enum(['golden', 'sqrt2', 'square', 'isometric']).default('golden'),
  /**
   * 手描き（筆致）として扱う。
   *
   * 整定は「ほぼ○○なら、まさに○○にする」——ほぼ円なら円に、ほぼ直線なら
   * 直線に寄せる。これは**規則的であろうとした絵**にだけ正しい。筆で一息に
   * 引いた線は、太細もゆらぎも意図された表現なので、規則へ寄せると死ぬ
   * （実測: 円相が真円 3 つに潰れ、太細もかすれも消えた）。
   *
   * 設計は保存され後から再コンパイルされるので、この区別は**設計自身が持つ**。
   * コンパイル時の引数にすると、読み直したときに失われる。
   */
  freehand: z.boolean().optional(),
  /**
   * 読み取り元の絵（PNG の data URI）。
   *
   * この道具は絵を作り直すのではなく、**絵を読んで作図シートを作る**。だから
   * 納品物は「元の絵 ＋ 作図シート」であって、復元したベクタで元の絵を置き換え
   * ない（実測: 素直なベクタ化に忠実度で 2〜5% 負ける。復元は元の絵を超えない）。
   * 設計と一緒に持ち回ることで、保存した会話を開き直しても元の絵が付いてくる。
   */
  source: z.string().max(4_000_000).optional(),
  palette: z.object({
    primary: hexColor.default('#111111'),
    secondary: hexColor.default('#8A8A8A'),
    accent: hexColor.default('#C2410C'),
    background: hexColor.default('#FFFFFF'),
  }).default({
    primary: '#111111',
    secondary: '#8A8A8A',
    accent: '#C2410C',
    background: '#FFFFFF',
  }),
  // 上限は「実用上ありえない規模」の線引き。ブーリアン演算は O(n²) 的に効くので、
  // 際限なく受け取るとブラウザが固まる。
  //
  // 64 から 96 へ上げた。花弁 26 枚の紋（向日葵）は、1 枚が 2 円のヴェシカなので
  // それだけで 52 シェイプ要る。96 シェイプの構成で build は実測 90ms なので、
  // 固まる水準からはまだ遠い。
  shapes: z.array(shapeSchema).min(1).max(96),
  constraints: z.array(constraintSchema).max(128).default([]),
  groups: z.array(groupSchema).max(48).default([]),
  parts: z.array(partSchema).min(1).max(16),
})

export type Circle = z.infer<typeof circleSchema>
export type Ring = z.infer<typeof ringSchema>
export type Bar = z.infer<typeof barSchema>
export type Rect = z.infer<typeof rectSchema>
export type Wedge = z.infer<typeof wedgeSchema>
export type Arc = z.infer<typeof arcSchema>
export type Poly = z.infer<typeof polySchema>
export type Contour = z.infer<typeof contourSchema>
export type Shape = z.infer<typeof shapeSchema>
export type Constraint = z.infer<typeof constraintSchema>
export type Step = z.infer<typeof stepSchema>
export type Group = z.infer<typeof groupSchema>
export type Part = z.infer<typeof partSchema>
export type LogoDesign = z.infer<typeof designSchema>

/** 中心を持つシェイプ（制約ソルバーが動かせる対象） */
export type Centered = Circle | Ring | Rect | Wedge | Arc

export function hasCenter(s: Shape): s is Centered {
  return (
    s.kind === 'circle' ||
    s.kind === 'ring' ||
    s.kind === 'rect' ||
    s.kind === 'wedge' ||
    s.kind === 'arc'
  )
}

/** 制約で使う「半径的な大きさ」。矩形は外接円相当を返す。 */
export function radiusOf(s: Centered): number {
  switch (s.kind) {
    case 'circle':
    case 'ring':
    case 'wedge':
      return s.r
    case 'arc':
      return s.r + s.w / 2
    case 'rect':
      return Math.hypot(s.w, s.h) / 2
  }
}
