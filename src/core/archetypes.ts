import { z } from 'zod'
import { build } from './build'
import { normalize } from './normalize'
import type { Constraint, LogoDesign, Shape } from './dsl'
import { PHI } from './units'

/**
 * 構成アーキタイプ（作図の型）。
 *
 * これまでは「原理を説明して自由に組ませる」方式だったが、それはモデルの
 * 設計判断力に依存する。幾何ロゴの実作を洗い出すと、構成は少数の型に収束する
 * ので、型ごとに **コードで幾何を生成** し、モデルには「どの型か」「どの比例か」
 * 程度しか選ばせない。こうすると:
 *
 *   - 接点・同心・重なりが構成上保証されるので、要素が浮かない
 *   - 半径・線幅・角度が比例体系から導かれるので、寸法が濁らない
 *   - 参照切れや潰れが起きない（コードが正しい DSL しか作らない）
 *
 * つまり品質がモデルの賢さに依存しなくなる。モデルの仕事は
 * 「主題をどの型に翻訳するか」という分類問題に縮む。
 */

export const ARCHETYPES = [
  'leaf',
  'leaf-stem',
  'crest',
  'arch',
  'bitten',
  'rosette',
  'concentric-arcs',
  'ring-gap',
  'orbit',
] as const

export type ArchetypeId = (typeof ARCHETYPES)[number]

/** 各型が何を表現するのに向くか。プロンプトでモデルに選ばせるための説明。 */
export const ARCHETYPE_GUIDE: Record<ArchetypeId, string> = {
  leaf: '2 円の交差（ヴェシカ）。葉・種・目・炎・魚・雫。最も端正で要素数が少ない',
  'leaf-stem': 'ヴェシカに円弧の茎が接する。芽・成長・生命・農業・環境',
  crest: 'ヴェシカを円弧が下から抱く。山と谷・保護・支援・地域',
  arch: '半円の弧の内側に円が収まる。門・橋・日の出・山と太陽・包容',
  bitten: '円板から円を食い込ませる。三日月・欠け・月・切り取り・鋭さ',
  rosette: '中心円のまわりに n 個の円を等配置。花・雪片・車輪・分散と統合',
  'concentric-arcs': '同心の円弧を比例刻みで展開。波紋・電波・等高線・広がり',
  'ring-gap': '環の一部を切り欠く。循環・C・G・継続・開かれた輪',
  orbit: '中心円のまわりを円弧が回る。軌道・衛星・観測・周回',
}

/**
 * 型の系統。作図の成り立ちで 4 つに分かれる。
 *
 * 候補を N 件並行生成するとき、同じブリーフを同じプロンプトで投げると
 * モデルはほぼ同じ型を選び、候補が重複して選ぶ意味がなくなる（実測）。
 * 候補ごとに系統を割り当てると、構成の異なる案が確実に並ぶ。
 * デザイナーが案を出すときの「別の方向から 1 案ずつ」と同じ分け方。
 */
export const ARCHETYPE_FAMILIES: ReadonlyArray<{
  readonly name: string
  readonly members: readonly ArchetypeId[]
}> = [
  { name: '交差（2 円が重なって形を生む）', members: ['leaf', 'leaf-stem', 'crest'] },
  { name: '包含（一方が他方を含む・欠く）', members: ['arch', 'bitten'] },
  { name: '反復（同じ要素を等間隔に並べる）', members: ['rosette', 'concentric-arcs'] },
  { name: '環（閉じた輪を操作する）', members: ['ring-gap', 'orbit'] },
]

export const RATIOS = ['golden', 'silver', 'integer'] as const
export const WEIGHTS = ['thin', 'regular', 'bold'] as const

/**
 * モデルが出しがちな別名を正規の型へ寄せる。
 *
 * 実測では、enum を JSON Schema に載せてもモデルは "wave" や "ripple" のような
 * 一覧に無い名前を返し、初回が必ず検証で落ちていた（＝毎回 2 回呼んでいた）。
 * 意味的に対応が明らかなものは受け入れる方が、再試行させるより速く安く正確。
 */
const ALIASES: Record<string, ArchetypeId> = {
  // 同心の円弧
  wave: 'concentric-arcs',
  waves: 'concentric-arcs',
  ripple: 'concentric-arcs',
  ripples: 'concentric-arcs',
  radiate: 'concentric-arcs',
  radial: 'concentric-arcs',
  signal: 'concentric-arcs',
  sonar: 'concentric-arcs',
  contour: 'concentric-arcs',
  layers: 'concentric-arcs',
  pulse: 'concentric-arcs',
  // ヴェシカ
  vesica: 'leaf',
  lens: 'leaf',
  eye: 'leaf',
  seed: 'leaf',
  drop: 'leaf',
  flame: 'leaf',
  fish: 'leaf',
  // 茎つき
  sprout: 'leaf-stem',
  stem: 'leaf-stem',
  plant: 'leaf-stem',
  growth: 'leaf-stem',
  // 抱擁
  mountain: 'crest',
  hill: 'crest',
  cradle: 'crest',
  shield: 'crest',
  // アーチ
  bridge: 'arch',
  gate: 'arch',
  dome: 'arch',
  sunrise: 'arch',
  horizon: 'arch',
  // かじり跡
  crescent: 'bitten',
  moon: 'bitten',
  bite: 'bitten',
  // 花
  flower: 'rosette',
  petal: 'rosette',
  petals: 'rosette',
  star: 'rosette',
  burst: 'rosette',
  wheel: 'rosette',
  // 環
  ring: 'ring-gap',
  circle: 'ring-gap',
  loop: 'ring-gap',
  cycle: 'ring-gap',
  // 軌道
  satellite: 'orbit',
  planet: 'orbit',
  circuit: 'orbit',
}

/** 型名を解決する。完全一致 → 正規化 → 別名 → 部分一致 の順。 */
export function resolveArchetype(input: string): ArchetypeId | null {
  const raw = input.trim()
  if ((ARCHETYPES as readonly string[]).includes(raw)) return raw as ArchetypeId

  const key = raw.toLowerCase().replace(/[\s_]+/g, '-')
  if ((ARCHETYPES as readonly string[]).includes(key)) return key as ArchetypeId
  if (ALIASES[key]) return ALIASES[key]

  const bare = key.replace(/-/g, '')
  for (const id of ARCHETYPES) {
    if (id.replace(/-/g, '') === bare) return id
  }
  for (const [alias, id] of Object.entries(ALIASES)) {
    if (key.includes(alias)) return id
  }
  for (const id of ARCHETYPES) {
    if (key.includes(id) || id.includes(key)) return id
  }
  return null
}

export const ENCLOSURES = ['none', 'ring', 'double', 'hex', 'square', 'diamond'] as const
export type EnclosureId = (typeof ENCLOSURES)[number]

/**
 * 囲いの別名。
 *
 * 完全一致だけを見て、外れたら "none" に倒していた。すると「方形フレーム」
 * という名前の案から囲いが消え、名前だけ残って形が伴わなくなる（実際に
 * 起きた）。黙って落とすより寄せる方がよいのは型名と同じ。
 */
const ENCLOSURE_ALIASES: Record<string, EnclosureId> = {
  // 丸
  circle: 'ring',
  round: 'ring',
  round_frame: 'ring',
  o: 'ring',
  丸: 'ring',
  円: 'ring',
  // 二重丸
  doublering: 'double',
  'double-ring': 'double',
  twin: 'double',
  二重丸: 'double',
  二重: 'double',
  // 亀甲
  hexagon: 'hex',
  hexagonal: 'hex',
  honeycomb: 'hex',
  亀甲: 'hex',
  六角: 'hex',
  六角形: 'hex',
  // 角（正方形）
  box: 'square',
  rect: 'square',
  rectangle: 'square',
  frame: 'square',
  角: 'square',
  方形: 'square',
  正方形: 'square',
  四角: 'square',
  // 隅立て角（菱）
  rhombus: 'diamond',
  rhomb: 'diamond',
  lozenge: 'diamond',
  菱: 'diamond',
  隅立て角: 'diamond',
  // 囲わない
  plain: 'none',
  なし: 'none',
  無し: 'none',
}

/** 囲いの名前を解決する。完全一致 → 別名 → 部分一致 の順。 */
export function resolveEnclosure(input: string): EnclosureId {
  const key = input.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if ((ENCLOSURES as readonly string[]).includes(key)) return key as EnclosureId
  if (ENCLOSURE_ALIASES[key]) return ENCLOSURE_ALIASES[key]
  for (const [alias, id] of Object.entries(ENCLOSURE_ALIASES)) {
    if (key.length > 1 && key.includes(alias)) return id
  }
  return 'none'
}

export const archetypeParamsSchema = z.object({
  // enum ではなく string + 別名解決。enum を載せてもモデルは一覧外の名前を
  // 返してくるので、弾くより寄せる方が実測で速く安い。
  archetype: z
    .string()
    .min(1)
    .describe(`構成の型。次のいずれかを選ぶ: ${ARCHETYPES.join(' / ')}`)
    .transform((value, ctx): ArchetypeId => {
      const resolved = resolveArchetype(value)
      if (!resolved) {
        ctx.addIssue({
          code: 'custom',
          message: `未知の型 "${value}"。次のいずれかにしてください: ${ARCHETYPES.join(', ')}`,
        })
        return ARCHETYPES[0]
      }
      return resolved
    }),
  ratio: z
    .enum(RATIOS)
    .default('golden')
    .describe('比例体系。golden=黄金比φ（有機的・力強い）/ silver=白銀比√2（静か・端正）/ integer=整数比（素朴・明快）'),
  weight: z
    .enum(WEIGHTS)
    .default('regular')
    .describe('線の太さ。thin=繊細 / regular=標準 / bold=力強い'),
  count: z
    .number()
    .int()
    .min(2)
    .max(8)
    .default(3)
    .describe('繰り返し数。rosette の花弁数、concentric-arcs の弧の本数などに使う'),
  span: z
    .number()
    .min(30)
    .max(330)
    .default(180)
    .describe('円弧の開き角（度）。arch は 180 前後、ring-gap は 270〜330 が扱いやすい'),
  orientation: z
    .number()
    .min(0)
    .max(359)
    .default(0)
    .describe('全体の回転角（度）。0=標準の向き。90 刻みで考えるとよい'),
  accent: z.boolean().default(false).describe('true なら副要素をアクセント色にする'),
  /**
   * 囲い。家紋の基本構造は「丸に◯◯」で、モチーフ単体では紋にならない。
   * 素の 2 図形で終わると、形ではあってもマークには見えない。
   */
  enclosure: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
      return resolveEnclosure(k)
    })
    .describe(
      'none / ring（丸に）/ double（二重丸に）/ hex（亀甲に）/ square（角に）/ diamond（隅立て角に）',
    ),
  /**
   * モチーフの反復数。三つ盛・三つ寄せのように、同じ形を等配置すると
   * 律動が生まれて紋になる。1 なら反復しない。
   */
  repeat: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number.parseInt(v, 10) : v
      return n === 3 || n === 4 ? n : 1
    })
    .describe('1 / 3（三つ盛）/ 4'),
})

export type ArchetypeParams = z.infer<typeof archetypeParamsSchema>

// --- 比例体系 ---

/** 半径の刻み。1 段上がるとこの倍率になる。 */
function step(ratio: ArchetypeParams['ratio']): number {
  switch (ratio) {
    case 'golden':
      return PHI
    case 'silver':
      return Math.SQRT2
    case 'integer':
      return 1.5
  }
}

/** 線幅（基準半径に対する比）。1/25 を大きく上回るよう取る。 */
function strokeOf(R: number, weight: ArchetypeParams['weight']): number {
  const k = weight === 'thin' ? 1 / 7 : weight === 'bold' ? 1 / 3 : 1 / 5
  return round(R * k)
}

const round = (v: number) => Math.round(v * 1000) / 1000

/** 基準半径。すべての寸法はここから導く。 */
const R = 3

type Built = { shapes: Shape[]; constraints: Constraint[]; steps: Array<{ op: 'add' | 'sub' | 'intersect'; ref: string }>; accentIds?: string[] }

// --- 各アーキタイプ ---

/**
 * ヴェシカ。同半径の 2 円を軸方向にずらして交差させる。
 * ずれ量 d が形の鋭さを決める（d が小さいほど丸く、r に近いほど尖る）。
 */
function leafShapes(p: ArchetypeParams, prefix = 'leaf'): Built {
  const k = p.ratio === 'golden' ? 1 / PHI : p.ratio === 'silver' ? 1 / Math.SQRT2 : 0.5
  const d = round(R * k)
  return {
    shapes: [
      { kind: 'circle', id: `${prefix}A`, cx: 0, cy: round(-d / 2), r: R, pinned: true },
      { kind: 'circle', id: `${prefix}B`, cx: 0, cy: round(d / 2), r: R, pinned: true },
    ],
    constraints: [{ type: 'align', ids: [`${prefix}A`, `${prefix}B`], axis: 'x' }],
    steps: [
      { op: 'add', ref: `${prefix}A` },
      { op: 'intersect', ref: `${prefix}B` },
    ],
  }
}

/** ヴェシカの下端の座標（茎や受け皿を必ず接触させるために使う） */
function leafBottom(p: ArchetypeParams): number {
  const k = p.ratio === 'golden' ? 1 / PHI : p.ratio === 'silver' ? 1 / Math.SQRT2 : 0.5
  const d = R * k
  return round(-d / 2 + R)
}

function buildLeaf(p: ArchetypeParams): Built {
  return leafShapes(p)
}

/**
 * 葉＋茎。茎の円弧は、開始角 0° の点がちょうど葉の下端に来るよう中心を置く。
 * 接触が構成上保証されるので、浮きようがない。
 */
function buildLeafStem(p: ArchetypeParams): Built {
  const leaf = leafShapes(p)
  const w = strokeOf(R, p.weight)
  const bottom = leafBottom(p)
  const A = round(R * step(p.ratio) * 0.7)
  const span = Math.min(Math.max(p.span, 45), 120)
  return {
    shapes: [
      ...leaf.shapes,
      // 中心 (-A, y)・半径 A の弧は角度 0° で (0, y) を通る。y を葉の下端より
      // w*0.4 だけ上にずらし、端点が葉の内側へ食い込むようにする。
      //
      // ⚠️ ちょうど下端に一致させる（＝1 点接触）と、ブーリアン演算が退化して
      //    結果が空になることがある。接触ではなく必ず「重なり」にすること。
      {
        kind: 'arc',
        id: 'stem',
        cx: round(-A),
        cy: round(bottom - w * 0.4),
        r: A,
        w,
        a0: 0,
        a1: round(span),
        cap: 'round',
      },
    ],
    constraints: leaf.constraints,
    steps: [...leaf.steps, { op: 'add', ref: 'stem' }],
    accentIds: ['stem'],
  }
}

/**
 * 葉を円弧が下から抱く。弧は葉の下端に食い込ませる（重なり量 w*0.4）ので、
 * 接触ではなく交差になり、幾何だけで関係が成立する。
 */
function buildCrest(p: ArchetypeParams): Built {
  const leaf = leafShapes(p)
  const w = strokeOf(R, p.weight)
  const bottom = leafBottom(p)
  const cradleR = round(R * step(p.ratio) * 0.85)
  // 弧の最上点 (cy - r) が葉の下端よりわずかに上に来るよう中心を置く
  const cy = round(bottom + cradleR - w * 0.4)
  const span = Math.min(Math.max(p.span, 90), 200)
  const half = round(span / 2)
  return {
    shapes: [
      ...leaf.shapes,
      { kind: 'arc', id: 'cradle', cx: 0, cy, r: cradleR, w, a0: round(270 - half), a1: round(270 + half), cap: 'round' },
    ],
    constraints: [...leaf.constraints, { type: 'align', ids: [`leafA`, 'cradle'], axis: 'x' }],
    steps: [...leaf.steps, { op: 'add', ref: 'cradle' }],
    accentIds: ['cradle'],
  }
}

/** 半円の弧の内側に円を収める。円は弧の帯に食い込ませて関係を作る。 */
function buildArch(p: ArchetypeParams): Built {
  const w = strokeOf(R, p.weight)
  const span = Math.min(Math.max(p.span, 120), 240)
  const half = round(span / 2)
  const inner = round(R * 0.45)
  // 円の上端が弧の帯へ w*0.35 だけ食い込む位置
  const d = round(R - w / 2 - inner + w * 0.35)
  return {
    shapes: [
      { kind: 'arc', id: 'arch', cx: 0, cy: 0, r: R, w, a0: round(270 - half), a1: round(270 + half), cap: 'butt' },
      { kind: 'circle', id: 'sun', cx: 0, cy: round(-d), r: inner },
    ],
    constraints: [{ type: 'align', ids: ['arch', 'sun'], axis: 'x' }],
    steps: [
      { op: 'add', ref: 'arch' },
      { op: 'add', ref: 'sun' },
    ],
    accentIds: ['sun'],
  }
}

/** 円板から円を食い込ませる（かじり跡・三日月）。 */
function buildBitten(p: ArchetypeParams): Built {
  const biteR = round(R * (p.ratio === 'integer' ? 0.75 : 1 / step(p.ratio) + 0.2))
  const d = round(R * 0.78)
  const a = ((p.span - 180) * Math.PI) / 180
  return {
    shapes: [
      { kind: 'circle', id: 'disc', cx: 0, cy: 0, r: R, pinned: true },
      { kind: 'circle', id: 'bite', cx: round(Math.cos(a) * d), cy: round(Math.sin(a) * d), r: biteR },
    ],
    constraints: [],
    steps: [
      { op: 'add', ref: 'disc' },
      { op: 'sub', ref: 'bite' },
    ],
  }
}

/** 中心円のまわりに n 個の円を等配置して union。 */
function buildRosette(p: ArchetypeParams): Built {
  const n = Math.min(Math.max(p.count, 3), 8)
  const petalR = round(R * 0.5)
  const orbit = round(R * 0.72)
  const shapes: Shape[] = [{ kind: 'circle', id: 'core', cx: 0, cy: 0, r: round(R * 0.45), pinned: true }]
  const steps: Built['steps'] = [{ op: 'add', ref: 'core' }]
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const id = `petal${i}`
    shapes.push({
      kind: 'circle',
      id,
      cx: round(Math.cos(a) * orbit),
      cy: round(Math.sin(a) * orbit),
      r: petalR,
    })
    steps.push({ op: 'add', ref: id })
  }
  return { shapes, constraints: [], steps }
}

/**
 * 同心の円弧を比例刻みで展開。
 *
 * 素直に比例体系の刻み（φ など）をそのまま n 回かけると、n が大きいときに
 * 最外周が基準半径の 4 倍以上になり、外接矩形の大半が空白になる
 *（実測: n=5・細線・開き 45° でインク比率 9%）。隣接比を一定に保ったまま、
 * 全体の広がりだけを抑えるよう刻みを圧縮する。
 */
function buildConcentricArcs(p: ArchetypeParams): Built {
  const n = Math.min(Math.max(p.count, 2), 5)
  const span = Math.min(Math.max(p.span, 40), 300)
  const half = round(span / 2)

  const rMin = R * 0.45
  const rMax = R * 1.6
  // 比例体系の刻みを基本にしつつ、最外周が rMax を超えない範囲へ圧縮する
  const k = Math.min(step(p.ratio), Math.pow(rMax / rMin, 1 / Math.max(n - 1, 1)))

  const outer = rMin * Math.pow(k, n - 1)
  // 帯が疎になりすぎないよう、広がりに応じて線幅の下限も引き上げる
  const w = round(Math.max(strokeOf(R, p.weight), (outer - rMin) / (n * 2.2)))

  const shapes: Shape[] = [
    { kind: 'circle', id: 'core', cx: 0, cy: 0, r: round(rMin * 0.62), pinned: true },
  ]
  const steps: Built['steps'] = [{ op: 'add', ref: 'core' }]
  const constraints: Constraint[] = []
  for (let i = 0; i < n; i++) {
    const id = `wave${i}`
    shapes.push({
      kind: 'arc',
      id,
      cx: 0,
      cy: 0,
      r: round(rMin * Math.pow(k, i)),
      w,
      a0: round(-half),
      a1: round(half),
      cap: 'butt',
    })
    steps.push({ op: 'add', ref: id })
    constraints.push({ type: 'concentric', a: 'core', b: id })
  }
  return { shapes, constraints, steps }
}

/** 環の一部を切り欠く（C / G / 循環）。 */
function buildRingGap(p: ArchetypeParams): Built {
  const w = strokeOf(R, p.weight)
  const gap = Math.min(Math.max(360 - p.span, 20), 140)
  const half = round(gap / 2)
  return {
    shapes: [
      { kind: 'ring', id: 'ring', cx: 0, cy: 0, r: R, w, pinned: true },
      { kind: 'wedge', id: 'gap', cx: 0, cy: 0, r: round(R + 1), a0: round(-half), a1: round(half), pinned: true },
    ],
    constraints: [{ type: 'concentric', a: 'ring', b: 'gap' }],
    steps: [
      { op: 'add', ref: 'ring' },
      { op: 'sub', ref: 'gap' },
    ],
  }
}

/** 中心円のまわりを円弧が回る。同心を宣言して関係を成立させる。 */
function buildOrbit(p: ArchetypeParams): Built {
  const w = strokeOf(R, p.weight)
  const span = Math.min(Math.max(p.span, 120), 300)
  const half = round(span / 2)
  return {
    shapes: [
      { kind: 'circle', id: 'core', cx: 0, cy: 0, r: round(R * 0.42), pinned: true },
      { kind: 'arc', id: 'path', cx: 0, cy: 0, r: round(R * 0.92), w, a0: round(-half), a1: round(half), cap: 'round' },
    ],
    constraints: [{ type: 'concentric', a: 'core', b: 'path' }],
    steps: [
      { op: 'add', ref: 'core' },
      { op: 'add', ref: 'path' },
    ],
    accentIds: ['path'],
  }
}

const BUILDERS: Record<ArchetypeId, (p: ArchetypeParams) => Built> = {
  leaf: buildLeaf,
  'leaf-stem': buildLeafStem,
  crest: buildCrest,
  arch: buildArch,
  bitten: buildBitten,
  rosette: buildRosette,
  'concentric-arcs': buildConcentricArcs,
  'ring-gap': buildRingGap,
  orbit: buildOrbit,
}

/** 図形全体を回転する（DSL に変換行列が無いので座標側を回す） */
function rotateShapes(shapes: Shape[], deg: number): Shape[] {
  if (Math.abs(deg % 360) < 1e-9) return shapes
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const rot = (x: number, y: number) => ({ x: round(x * cos - y * sin), y: round(x * sin + y * cos) })

  return shapes.map((s): Shape => {
    switch (s.kind) {
      case 'circle':
      case 'ring': {
        const c = rot(s.cx, s.cy)
        return { ...s, cx: c.x, cy: c.y }
      }
      case 'wedge':
      case 'arc': {
        const c = rot(s.cx, s.cy)
        return { ...s, cx: c.x, cy: c.y, a0: round(s.a0 + deg), a1: round(s.a1 + deg) }
      }
      case 'rect': {
        const c = rot(s.cx, s.cy)
        return { ...s, cx: c.x, cy: c.y, rotate: round((s.rotate ?? 0) + deg) }
      }
      case 'bar': {
        const a = rot(s.x1, s.y1)
        const b = rot(s.x2, s.y2)
        return { ...s, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
      }
      case 'poly':
        return { ...s, points: s.points.map((pt) => rot(pt.x, pt.y)) }
      case 'contour':
        // 半径と回り方は回転で変わらない。通過点だけ回せばよい
        return { ...s, segments: s.segments.map((seg) => ({ ...seg, ...rot(seg.x, seg.y) })) }
    }
  })
}

/**
 * 制約を回転に追従させる。
 *
 * tangent / concentric / onCircle は距離の条件なので回転で不変。
 * align だけは軸を持つので変換が要る: 90°・270° では x↔y が入れ替わり、
 * 90 の倍数でない回転では「軸に平行」という条件自体が表現できないため落とす。
 * （落としても、対象の図形は重なっているので関係は保たれる）
 */
function rotateConstraints(constraints: Constraint[], deg: number): Constraint[] {
  const norm = ((deg % 360) + 360) % 360
  const out: Constraint[] = []
  for (const c of constraints) {
    if (c.type !== 'align') {
      out.push(c)
      continue
    }
    if (norm === 0 || norm === 180) {
      out.push(c)
    } else if (norm === 90 || norm === 270) {
      out.push({ ...c, axis: c.axis === 'x' ? 'y' : 'x' })
    }
    // それ以外は軸で表現できないので落とす
  }
  return out
}

export type ArchetypePlan = {
  name: string
  concept: string
  params: ArchetypeParams
  palette?: LogoDesign['palette']
}

/**
 * アーキタイプとパラメータから、必ず妥当な LogoDesign を組み立てる。
 *
 * 生成されるのは「幾何として成立し、要素が結ばれ、比例が揃った」設計に限られる。
 * モデルはここへ至る分類（どの型か・どの比例か）だけを担う。
 */
/** シェイプを縮小して移動する。反復配置に使う。 */
function placeShapes(shapes: Shape[], scale: number, dx: number, dy: number, tag: string): Shape[] {
  const at = (x: number, y: number) => ({ x: round(x * scale + dx), y: round(y * scale + dy) })
  const s = (v: number) => round(v * scale)

  return shapes.map((sh): Shape => {
    const id = `${sh.id}${tag}`
    switch (sh.kind) {
      case 'circle': {
        const c = at(sh.cx, sh.cy)
        return { ...sh, id, cx: c.x, cy: c.y, r: s(sh.r) }
      }
      case 'ring': {
        const c = at(sh.cx, sh.cy)
        return { ...sh, id, cx: c.x, cy: c.y, r: s(sh.r), w: s(sh.w) }
      }
      case 'wedge': {
        const c = at(sh.cx, sh.cy)
        return { ...sh, id, cx: c.x, cy: c.y, r: s(sh.r) }
      }
      case 'arc': {
        const c = at(sh.cx, sh.cy)
        return { ...sh, id, cx: c.x, cy: c.y, r: s(sh.r), w: s(sh.w) }
      }
      case 'rect': {
        const c = at(sh.cx, sh.cy)
        return { ...sh, id, cx: c.x, cy: c.y, w: s(sh.w), h: s(sh.h) }
      }
      case 'bar': {
        const a = at(sh.x1, sh.y1)
        const b = at(sh.x2, sh.y2)
        return { ...sh, id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: s(sh.w) }
      }
      case 'poly':
        return { ...sh, id, points: sh.points.map((q) => at(q.x, q.y)) }
      case 'contour':
        return {
          ...sh,
          id,
          segments: sh.segments.map((g) => ({
            ...g,
            ...at(g.x, g.y),
            r: g.r === undefined ? undefined : s(g.r),
          })),
        }
    }
  })
}

/**
 * 組み立て後の外形から、原点までの最遠距離を測る。
 *
 * シェイプの寸法から見積もると、intersect を使う型（葉・山）で大きく
 * 過大評価する（葉は円の半径 3 に対して実寸 2.85）。囲いに収めるときは
 * 過大評価すると必要以上に縮むので、実寸で測る。
 */
function builtRadius(
  shapes: Shape[],
  steps: Array<{ op: 'add' | 'sub' | 'intersect'; ref: string }>,
): number {
  try {
    const M = 64
    const b = build(
      normalize({
        name: 'probe',
        concept: '',
        module: M,
        grid: 'golden',
        palette: { primary: '#000', secondary: '#000', accent: '#000', background: '#fff' },
        shapes,
        constraints: [],
        groups: [],
        parts: [{ id: 'p', steps, fill: 'primary', mirror: 'none' }],
      }).design,
    ).artBounds
    if (b.width <= 0 || b.height <= 0) return extentOf(shapes)
    // artBounds は px なのでモジュール単位へ戻す。ここを取り違えると
    // 64 倍の値で縮めることになり、モチーフが消える
    return (
      Math.max(
        Math.hypot(b.x, b.y),
        Math.hypot(b.x + b.width, b.y),
        Math.hypot(b.x, b.y + b.height),
        Math.hypot(b.x + b.width, b.y + b.height),
      ) / M
    )
  } catch {
    return extentOf(shapes)
  }
}

/** 原点からの最遠点。囲いに収めるための粗い見積もり。 */
function extentOf(shapes: Shape[]): number {
  const h = (x: number, y: number) => Math.hypot(x, y)
  let max = 0
  for (const sh of shapes) {
    switch (sh.kind) {
      case 'circle':
      case 'wedge':
        max = Math.max(max, h(sh.cx, sh.cy) + sh.r)
        break
      case 'ring':
      case 'arc':
        max = Math.max(max, h(sh.cx, sh.cy) + sh.r + sh.w / 2)
        break
      case 'rect':
        max = Math.max(max, h(Math.abs(sh.cx) + sh.w / 2, Math.abs(sh.cy) + sh.h / 2))
        break
      case 'bar':
        max = Math.max(max, h(sh.x1, sh.y1) + sh.w / 2, h(sh.x2, sh.y2) + sh.w / 2)
        break
      case 'poly':
        for (const q of sh.points) max = Math.max(max, h(q.x, q.y))
        break
      case 'contour':
        for (const g of sh.segments) max = Math.max(max, h(g.x, g.y))
        break
    }
  }
  return max
}

/** 要素が互いに離れていないか。離れていると 1 つのマークに見えない。 */
function isDisjoint(placed: {
  shapes: Shape[]
  constraints: Constraint[]
  groups: Array<Array<{ op: 'add' | 'sub' | 'intersect'; ref: string }>>
}): boolean {
  try {
    return (
      build(
        // 本番と同じく正規化を通す。素の寸法で測ると、半径の丸めで輪が
        // ずれた分だけ判定が食い違う（実際に食い違った）
        normalize({
          name: 'probe',
          concept: '',
          module: 64,
          grid: 'golden',
          palette: { primary: '#000', secondary: '#000', accent: '#000', background: '#fff' },
          shapes: placed.shapes,
          constraints: placed.constraints,
          groups: [],
          parts: placed.groups.map((g, i) => ({
            id: `p${i}`,
            steps: g,
            fill: 'primary' as const,
            mirror: 'none' as const,
          })),
        }).design,
      ).unrelated.length > 0
    )
  } catch {
    return false
  }
}

/** 正 n 角形の頂点。輪と違って向きがあるので、上を頂点に取る。 */
function polygon(n: number, r: number, turn: number): Array<{ x: number; y: number }> {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + turn + (i * 2 * Math.PI) / n
    return { x: round(Math.cos(a) * r), y: round(Math.sin(a) * r) }
  })
}

/** 制約の参照先にコピーの印を付ける。 */
function retagConstraint(c: Constraint, tag: string): Constraint {
  const t = (ref: string) => `${ref}${tag}`
  switch (c.type) {
    case 'align':
      return { ...c, ids: c.ids.map(t) }
    case 'onCircle':
      return { ...c, point: t(c.point), circle: t(c.circle) }
    default:
      return { ...c, a: t(c.a), b: t(c.b) }
  }
}

export function buildFromArchetype(plan: ArchetypePlan): LogoDesign {
  const params = archetypeParamsSchema.parse(plan.params)
  const built = BUILDERS[params.archetype](params)
  let shapes = rotateShapes(built.shapes, params.orientation)
  let constraints = rotateConstraints(built.constraints, params.orientation)
  let steps = built.steps

  // 反復。同じ形を等配置すると律動が生まれる（三つ盛・四つ寄せ）。
  //
  // コピーごとに別パーツにするのが要点。ブーリアン演算は積み上がった図形
  // 全体に効くので、intersect を含む型の手順を単純に並べると、2 つ目の
  // コピーが 1 つ目を削ってしまう（実際に葉と山が壊れた）。
  let groups: Array<Array<{ op: 'add' | 'sub' | 'intersect'; ref: string }>> = [steps]
  if (params.repeat > 1) {
    const n = params.repeat
    const scale = n === 3 ? 0.5 : 0.44

    // 配置する半径を解析で決めようとすると外す。交差型は外形が中心から
    // ずれるうえ、方向によって幅が違うので、外接円でも外接矩形でも当たらない。
    // 組み立てて「隣と繋がっているか」を見て詰める方が確実で、これは
    // このコードベースが一貫して採っている「弾かずに直す」やり方でもある。
    const place = (orbit: number) => {
      const copies: Shape[] = []
      const copyConstraints: Constraint[] = []
      const copyGroups: typeof groups = []
      for (let i = 0; i < n; i++) {
        // 上を起点に等配置する。下向き起点だと逆さに見える
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
        const tag = `x${i}`
        copies.push(
          ...placeShapes(shapes, scale, round(Math.cos(a) * orbit), round(Math.sin(a) * orbit), tag),
        )
        copyGroups.push(steps.map((st) => ({ ...st, ref: `${st.ref}${tag}` })))
        // コピー内部の関係（同心・接する等）を写す。捨てると、元は宣言で
        // 結ばれていた要素が浮いてしまう。コピー同士は接触で結ばれる
        copyConstraints.push(...constraints.map((c) => retagConstraint(c, tag)))
      }
      return { shapes: copies, constraints: copyConstraints, groups: copyGroups }
    }

    // 外接円から始めて、隣と繋がるまで詰める。繋がった時点で止めるので、
    // 必要以上に重ならない（＝隙間のある盛り方を保てる）
    let orbit = (scale * extentOf(shapes)) / Math.sin(Math.PI / n)
    let placed = place(round(orbit))
    for (let i = 0; i < 14 && isDisjoint(placed); i++) {
      orbit *= 0.88
      placed = place(round(orbit))
    }
    shapes = placed.shapes
    constraints = placed.constraints
    groups = placed.groups
  }

  const accent = new Set(params.accent ? (built.accentIds ?? []) : [])
  const parts: LogoDesign['parts'] = []

  // アクセントを使うときだけ part を分ける（塗り分けは part 単位のため）
  groups.forEach((g, i) => {
    const main = g.filter((st) => !accent.has(st.ref))
    if (main.length > 0) parts.push({ id: `mark${i || ''}`, steps: main, fill: 'primary', mirror: 'none' })
    const acc = g.filter((st) => accent.has(st.ref))
    if (acc.length > 0) {
      parts.push({
        id: `accent${i || ''}`,
        steps: [{ ...acc[0], op: 'add' as const }, ...acc.slice(1)],
        fill: 'accent',
        mirror: 'none',
      })
    }
  })

  // 囲い。家紋の基本構造は「丸に◯◯」で、モチーフ単体では紋にならない
  if (params.enclosure !== 'none') {
    const w = strokeOf(R, params.weight)
    // 輪はモチーフに寄り添わせる。固定寸法だと、小さいモチーフでは輪だけが
    // 大きくなり、中の線が短辺に対して細くなりすぎて小サイズで消える。
    // 本物の「丸に◯◯」も、輪と紋の間はこの程度しか空けない
    const extent = Math.max(...parts.map((pt) => builtRadius(shapes, pt.steps)))
    // 輪はモチーフを含み、少し余白を空ける。固定寸法だと小さいモチーフで
    // 輪だけが大きくなり、中の線が短辺に対して細くなって小サイズで消える。
    // 逆に接するまで詰めると輪と紋が溶けて読めなくなる（実際に濁った）
    // 二重にするときは二本目の場所を空ける。詰めると外側と溶けて一本に見える
    const gap = params.enclosure === 'double' ? w * 2.9 : w * 1.4
    const outer = round(extent + gap)

    // 丸だけだと、どの主題でも同じ輪になって案が並ばない。家紋にも
    // 亀甲・隅立て角があり、囲いの形そのものが性格を持つ
    const poly = params.enclosure === 'hex' ? 6 : params.enclosure === 'diamond' || params.enclosure === 'square' ? 4 : 0
    // 正方形は辺を水平に置く（頂点を上に置くと隅立て角になる）
    const turn = params.enclosure === 'square' ? Math.PI / 4 : 0
    const rings: Shape[] =
      poly === 0
        ? [{ kind: 'ring', id: 'encl', cx: 0, cy: 0, r: outer, w }]
        : [
            { kind: 'poly', id: 'encl', points: polygon(poly, round(outer + w / 2), turn) },
            { kind: 'poly', id: 'enclHole', points: polygon(poly, round(outer - w / 2), turn) },
          ]
    // 内側は細く。同じ太さで二本引くと重く、輪の内外が読めなくなる。
    // 輪がモチーフに寄っているときは二本目が入らないので、そのときは引かない
    const innerR = round(outer - w * 1.9)
    const innerW = round(w * 0.45)
    if (params.enclosure === 'double' && innerR > innerW) {
      rings.push({ kind: 'ring', id: 'encl2', cx: 0, cy: 0, r: innerR, w: innerW })
    }
    shapes = [...shapes, ...rings]
    // 多角形の囲いも 2 つのシェイプになるので、本数では判定できない
    if (rings.some((r) => r.id === 'encl2')) {
      constraints.push({ type: 'concentric', a: 'encl2', b: 'encl' })
    }
    parts.push({
      id: 'enclosure',
      steps: rings.map((r) => ({ op: r.id === 'enclHole' ? ('sub' as const) : ('add' as const), ref: r.id })),
      fill: 'primary',
      mirror: 'none',
    })
  }

  // 小サイズでの下限。囲いを足すと外形が広がり、反復では縮むので、
  // どちらも既存の線が相対的に細くなる。作図後に一度だけ底上げする
  const floor = extentOf(shapes) * 2 * (1 / 22)
  // 下限を負えないほど小さい環・円弧は、引いても小さいサイズで消える。
  // 消える線は引かない方がよいので落とす（パーツが空になる場合は残す）
  const tooSmall = new Set(
    shapes
      .filter((sh) => (sh.kind === 'ring' || sh.kind === 'arc') && sh.r * 0.5 < floor)
      .map((sh) => sh.id),
  )
  for (const part of parts) {
    if (part.steps.every((st) => tooSmall.has(st.ref))) {
      for (const st of part.steps) tooSmall.delete(st.ref)
    }
  }
  if (tooSmall.size > 0) {
    shapes = shapes.filter((sh) => !tooSmall.has(sh.id))
    constraints = constraints.filter((c) =>
      (c.type === 'align' ? c.ids : c.type === 'onCircle' ? [c.point, c.circle] : [c.a, c.b]).every(
        (r) => !tooSmall.has(r),
      ),
    )
    for (const part of parts) part.steps = part.steps.filter((st) => !tooSmall.has(st.ref))
  }

  shapes = shapes.map((sh) =>
    (sh.kind === 'ring' || sh.kind === 'arc' || sh.kind === 'bar') && sh.w < floor
      ? { ...sh, w: round(Math.min(floor, sh.kind === 'bar' ? floor : sh.r * 0.5)) }
      : sh,
  )

  return {
    name: plan.name,
    concept: plan.concept,
    module: 64,
    grid: params.ratio === 'silver' ? 'sqrt2' : 'golden',
    palette: plan.palette ?? {
      primary: '#111111',
      secondary: '#8A8A8A',
      accent: '#C2410C',
      background: '#FFFFFF',
    },
    shapes,
    constraints,
    groups: [],
    parts,
  }
}
