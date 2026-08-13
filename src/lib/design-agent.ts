import { generateObject, type LanguageModel } from 'ai'
import { compile, designSchema, type CompileResult, type LogoDesign } from '../core/index'
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

const MAX_ATTEMPTS = 2

/**
 * ブリーフ → DSL → コンパイル。
 *
 * ブラウザ（静的モード）とサーバー（Hono）の両方から呼ばれる。LanguageModel を
 * 引数で受け取るので、プロバイダー解決とキーの持ち方は呼び出し側の責務になる。
 *
 * ビルドが破綻した場合だけ、具体的な問題点を添えて 1 度やり直す。
 * 「見た目が良いか」ではなく「幾何として成立しているか」を機械的に判定するので、
 * 判定がぶれず、リトライが無限に回らない。
 */
export async function designLogo(
  brief: string,
  model: LanguageModel,
): Promise<DesignOutcome> {
  const attempts: DesignAttempt[] = []
  let lastResult: CompileResult | null = null

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const problems = attempts.at(-1)?.problems
    const prompt = problems?.length ? repairPrompt(brief, problems) : userPrompt(brief)

    const { object } = await generateObject({
      model,
      schema: designSchema,
      system: SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 16000,
    })

    const result = compile(object as LogoDesign)
    lastResult = result

    const found = diagnose(result)
    attempts.push({ index: i, problems: found })
    if (found.length === 0) break
  }

  if (!lastResult) {
    throw new CodedError('Failed to generate a design.', 'DESIGN_STRUCTURE_FAILED')
  }
  return { brief, result: lastResult, attempts }
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
