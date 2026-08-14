import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { archetypeParamsSchema, buildFromArchetype } from '../core/archetypes'
import { compile, type CompileResult } from '../core/index'
import { CodedError } from './ai-error-codes'
import { repairPrompt, SYSTEM_PROMPT, userPrompt } from './design-prompt'

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
): Promise<DesignOutcome> {
  const attempts: DesignAttempt[] = []
  let lastResult: CompileResult | null = null
  let lastError: unknown = null

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const problems = attempts.at(-1)?.problems
    const prompt = problems?.length ? repairPrompt(brief, problems) : userPrompt(brief)

    let object: unknown
    try {
      const generated = await generateObject({
        model,
        schema: designPlanSchema,
        system: SYSTEM_PROMPT,
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

    const plan = object as DesignPlan
    const result = compile(
      buildFromArchetype({ name: plan.name, concept: plan.concept, params: plan }),
    )
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
