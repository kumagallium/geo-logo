import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import {
  ARCHETYPE_FAMILIES,
  archetypeParamsSchema,
  buildFromArchetype,
} from '../core/archetypes'
import { buildFromComposition, compositionSchema } from '../core/composition'
import { compile, type CompileResult, type LogoDesign } from '../core/index'
import { CodedError } from './ai-error-codes'
import {
  COMPOSITION_SYSTEM_PROMPT,
  compositionRepairPrompt,
  compositionUserPrompt,
} from './composition-prompt'
import { repairPrompt, systemPrompt, userPrompt } from './design-prompt'

/** 部品方式の計画。幾何は core/composition.ts が組み立てる。 */
export const compositionPlanSchema = compositionSchema

export type DesignAttempt = {
  index: number
  problems: string[]
}

export type DesignOutcome = {
  brief: string
  result: CompileResult
  attempts: DesignAttempt[]
}

/**
 * モデルに書かせるのは「型の選択」だけ。幾何は core/archetypes.ts が生成する。
 * DSL 全体を書かせていた頃は、参照切れ・浮いた要素・濁った寸法が頻発した。
 */
// 入れ子にせず平坦にする。params で括ると、モデルはパラメータを最上位へ
// 置いてしまい初回が必ず検証で落ちていた（実測）。構造は浅いほど間違えない。
export const designPlanSchema = archetypeParamsSchema.extend({
  name: z.string().min(1).max(40),
  concept: z.string().min(1).max(600),
})

export type DesignPlan = z.infer<typeof designPlanSchema>

/**
 * 構成モード。
 *
 * archetype: 9 種の型から選ばせる。抽象的な主題（循環・成長・波紋）に強く、
 *            幾何の破綻がまず起きない。ただし出せるマークは 9 種類しかない。
 * composition: 部品を自由に配置させる。具体的な題材（動物・道具・建物）を
 *            扱えるが、配置はモデル任せになるぶん当たり外れがある。
 *
 * どちらが合うかは題材次第で、事前に判定するには 1 回余分に推論が要る。
 * 候補を並行生成しているので、両方を混ぜて人に選ばせるほうが安く確実。
 */
export type DesignMode =
  | { kind: 'archetype'; family?: (typeof ARCHETYPE_FAMILIES)[number] }
  | { kind: 'composition'; angle?: string }

/**
 * 部品方式で候補を分けるための視点。デザイナーが案を出すときの切り口。
 *
 * 「顔や頭部」のように題材を限定する語を入れると、顔を持たない主題
 *（循環型経済など）にまで顔を作らせてしまう（実測）。どんな題材にも
 * 当てはまる引き方にする。
 */
const COMPOSITION_ANGLES = [
  // 見る角度そのものが設計判断。ゴリラを正面の顔で捉えるとクマにしか
  // 見えないが、横から見た四つ足の立ち姿なら一目でゴリラと分かる。
  // 題材に向きが無いもの（循環・成長など）は「向きがあるなら」で読み飛ばせる。
  '全体の姿。題材に向きがあるなら、最も特徴が出る角度（多くは横から）で捉える',
  '最も象徴的な一部分だけを大きく切り取った形',
]

/**
 * 候補 i 番に割り当てる構成モード。
 *
 * 偶数番をアーキタイプ、奇数番を部品方式にして交互に並べる。題材が抽象か
 * 具体かを事前に判定するには 1 回余分に推論が要るので、判定せずに両方出して
 * 人に選ばせる。候補が 2 件でも両方式が 1 件ずつ並ぶ。
 *
 * サーバーモードとブラウザ直叩きの両方から呼ぶ。番号だけを API で受け渡し、
 * 割り当ての規則はここに一元化する。
 */
export function modeForVariant(index: number): DesignMode {
  const i = Math.max(0, Math.trunc(index))
  if (i % 2 === 0) {
    return {
      kind: 'archetype',
      family: ARCHETYPE_FAMILIES[(i / 2) % ARCHETYPE_FAMILIES.length],
    }
  }
  return {
    kind: 'composition',
    angle: COMPOSITION_ANGLES[((i - 1) / 2) % COMPOSITION_ANGLES.length],
  }
}

type ModeSpec = {
  schema: z.ZodType
  system: string
  user: string
  repair: (problems: string[]) => string
  build: (object: unknown) => LogoDesign
}

function specFor(brief: string, mode: DesignMode): ModeSpec {
  if (mode.kind === 'composition') {
    return {
      schema: compositionPlanSchema,
      system: COMPOSITION_SYSTEM_PROMPT,
      user: compositionUserPrompt(brief, mode.angle),
      repair: (problems) => compositionRepairPrompt(brief, problems),
      build: (object) => buildFromComposition(compositionPlanSchema.parse(object)),
    }
  }
  return {
    schema: designPlanSchema,
    system: systemPrompt(mode.family?.members),
    user: userPrompt(brief, mode.family?.name),
    repair: (problems) => repairPrompt(brief, problems),
    build: (object) => {
      const plan = designPlanSchema.parse(object)
      return buildFromArchetype({ name: plan.name, concept: plan.concept, params: plan })
    },
  }
}

const MAX_ATTEMPTS = 3

/**
 * ブリーフ → DSL → コンパイル。
 *
 * ブラウザ（静的モード）とサーバー（Hono）の両方から呼ばれる。LanguageModel を
 * 引数で受け取るので、プロバイダー解決とキーの持ち方は呼び出し側の責務になる。
 *
 * リトライは 2 種類の失敗を等しく扱う:
 *   - スキーマ検証の失敗（色が 16 進でない、id に使えない文字、範囲外の数値 …）
 *   - 幾何の破綻（参照切れ、制約が解けない、intersect の結果が空 …）
 *
 * どちらも「モデルが直せる具体的な指摘」に翻訳して投げ直す。判定はいずれも
 * 決定的なので、リトライが無限に回らない。
 */
export async function designLogo(
  brief: string,
  model: LanguageModel,
  mode: DesignMode = { kind: 'archetype' },
): Promise<DesignOutcome> {
  const attempts: DesignAttempt[] = []
  let lastResult: CompileResult | null = null
  let lastError: unknown = null
  const spec = specFor(brief, mode)

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const problems = attempts.at(-1)?.problems
    const prompt = problems?.length ? spec.repair(problems) : spec.user

    let object: unknown
    try {
      const generated = await generateObject({
        model,
        schema: spec.schema,
        system: spec.system,
        prompt,
        maxOutputTokens: 4000,
      })
      object = generated.object
    } catch (err) {
      // 認証エラーやレート制限を投げ直さずに再試行すると、同じ失敗を
      // 繰り返して本当の原因が見えなくなる。生成・検証の失敗だけ拾う。
      if (!isRetriableGenerationError(err)) throw err
      lastError = err
      attempts.push({
        index: i,
        problems: [`出力がスキーマに合いませんでした:\n${describeValidationFailure(err)}`],
      })
      continue
    }

    const result = compile(spec.build(object))
    lastResult = result

    const found = diagnose(result)
    attempts.push({ index: i, problems: found })
    if (found.length === 0) break
  }

  if (!lastResult) {
    const detail = describeValidationFailure(lastError)
    throw new CodedError(
      `AI の出力を設計 DSL に変換できませんでした（${MAX_ATTEMPTS} 回試行）。${detail}`,
      'DESIGN_STRUCTURE_FAILED',
    )
  }
  return { brief, result: lastResult, attempts }
}

/**
 * 再試行して意味がある失敗か。
 *
 * AI SDK のエラークラスを import して instanceof で判定するとバージョン差で
 * 壊れやすいので、形で判定する。statusCode を持つものは API 側の応答
 *（401 / 429 / 5xx）なので、同じ内容を投げ直しても結果は変わらない。
 */
function isRetriableGenerationError(err: unknown): boolean {
  const e = err as { name?: string; statusCode?: number } | null
  if (typeof e?.statusCode === 'number') return false
  const name = String(e?.name ?? '')
  return /NoObjectGenerated|TypeValidation|JSONParse|InvalidJson/i.test(name)
}

/**
 * 検証失敗の中身をモデルへ返せる形に整える。
 * zod の issues は cause に入れ子で入るので、辿って path と message を拾う。
 */
export function describeValidationFailure(err: unknown): string {
  const lines: string[] = []
  const seen = new Set<string>()

  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    const n = node as {
      issues?: Array<{ path?: unknown[]; message?: string }>
      cause?: unknown
    }
    if (Array.isArray(n.issues)) {
      for (const issue of n.issues.slice(0, 15)) {
        const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
        const line = `${path || '(root)'}: ${issue.message ?? 'invalid'}`
        if (!seen.has(line)) {
          seen.add(line)
          lines.push(line)
        }
      }
    }
    walk(n.cause, depth + 1)
  }
  walk(err, 0)

  // AI SDK は生成できなかった生テキストを text に載せる。zod の issues だけでは
  // 「何を返したのか」が分からず直しようがないので、併せて返す。
  const raw = (err as { text?: unknown })?.text
  const sample = typeof raw === 'string' && raw ? `\n実際の出力: ${raw.slice(0, 400)}` : ''

  if (lines.length > 0) return lines.join('\n') + sample
  const message = err instanceof Error ? err.message : String(err ?? '')
  return message.slice(0, 500) + sample
}

/** ビルド結果が幾何として成立しているかの機械判定 */
export function diagnose(result: CompileResult): string[] {
  const problems: string[] = [...result.warnings, ...result.constraintErrors]

  if (result.built.parts.length === 0) {
    problems.push('塗り形状が 1 つも生成されなかった')
  }
  for (const part of result.built.parts) {
    if (!part.pathData) problems.push(`part ${part.id} のパスが空`)
  }

  if (result.built.collapsedTo) {
    problems.push(
      `完成形がシェイプ "${result.built.collapsedTo}" そのものと同じ形になっている。` +
        'add と intersect の順序を見直してください（外形でクリップするなら、内側の要素を' +
        'すべて add した後に intersect を 1 回だけ置く。外形自体を add してしまうと' +
        '全体が外形に戻ります）。',
    )
  }

  if (result.built.unrelated.length > 0) {
    problems.push(
      `シェイプ ${result.built.unrelated.join(', ')} が他の要素と何の関係も持たず浮いています。` +
        '重ねる（intersect / sub で噛み合わせる）か、constraints で関係を宣言してください' +
        '（tangent で接する / onCircle で中心を相手の円周上に置く / concentric で同心 / align で整列）。' +
        '離れて置かれた部品は 1 つのマークに見えません。',
    )
  }

  // 小サイズでの成立性。ロゴはファビコンや印刷でも読めなければ使えない。
  const { inkRatio, minStrokeRatio } = result.built
  if (inkRatio > 0 && inkRatio < 0.12) {
    problems.push(
      `塗りが外接矩形の ${(inkRatio * 100).toFixed(0)}% しかなく、大半が空白です。` +
        '線を太くするか要素を大きくして、小さいサイズでも形が読めるようにしてください' +
        '（目安 15〜50%）。',
    )
  }
  if (inkRatio > 0.92) {
    problems.push(
      `塗りが外接矩形の ${(inkRatio * 100).toFixed(0)}% を占めており、ほぼ単色の塊です。` +
        'sub で抜くか、要素の関係で形を作ってください。',
    )
  }
  if (minStrokeRatio !== null && minStrokeRatio < 0.04) {
    problems.push(
      `最も細い線がマークの短辺の 1/${Math.round(1 / minStrokeRatio)} しかなく、` +
        '小さいサイズで消えます。線幅を短辺の 1/25 以上にしてください。',
    )
  }

  const { artBounds } = result.built
  const M = result.design.module
  if (artBounds.width < M * 0.5 || artBounds.height < M * 0.5) {
    problems.push('完成形が極端に小さい（intersect の結果がほぼ空になっている可能性）')
  }
  const aspect = artBounds.width / Math.max(artBounds.height, 1e-6)
  if (aspect > 12 || aspect < 1 / 12) {
    problems.push(`完成形の縦横比が極端（${aspect.toFixed(1)}:1）`)
  }
  return problems
}
