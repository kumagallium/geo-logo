import { z } from 'zod'
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
export function buildFromArchetype(plan: ArchetypePlan): LogoDesign {
  const params = archetypeParamsSchema.parse(plan.params)
  const built = BUILDERS[params.archetype](params)
  const shapes = rotateShapes(built.shapes, params.orientation)
  const constraints = rotateConstraints(built.constraints, params.orientation)
  const accent = new Set(params.accent ? (built.accentIds ?? []) : [])

  // アクセントを使うときだけ part を分ける（塗り分けは part 単位のため）
  const mainSteps = built.steps.filter((s) => !accent.has(s.ref))
  const accentSteps = built.steps.filter((s) => accent.has(s.ref))

  const parts: LogoDesign['parts'] =
    accentSteps.length > 0 && mainSteps.length > 0
      ? [
          { id: 'mark', steps: mainSteps, fill: 'primary', mirror: 'none' },
          {
            id: 'accent',
            steps: [{ ...accentSteps[0], op: 'add' as const }, ...accentSteps.slice(1)],
            fill: 'accent',
            mirror: 'none',
          },
        ]
      : [{ id: 'mark', steps: built.steps, fill: 'primary', mirror: 'none' }]

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
