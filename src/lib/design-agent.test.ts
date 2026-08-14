import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { ARCHETYPES } from '../core/archetypes'
import { describeValidationFailure, designLogo, designPlanSchema } from './design-agent'
import { SYSTEM_PROMPT } from './design-prompt'

/**
 * 修復リトライは 2 種類の失敗を扱う必要がある:
 *   - スキーマ検証の失敗（モデルが色を "black" と書いた等）
 *   - 幾何の破綻（intersect の結果が空 等）
 * 前者は以前 try/catch されておらず、例外がそのまま抜けてリトライを迂回していた。
 *
 * 一方で認証エラー（401）まで再試行すると、同じ失敗を繰り返して
 * 本当の原因が見えなくなるので、そこは即座に投げ直す。
 */

/** 妥当な計画。アーキタイプとパラメータだけを返す。 */
const VALID = {
  name: 'Test Mark',
  concept: 'テスト用の計画',
  archetype: 'leaf',
  ratio: 'golden',
  weight: 'regular',
  count: 3,
  span: 180,
  orientation: 0,
  accent: false,
}

/** 存在しない型を指した計画 = スキーマ検証で弾かれる典型 */
const INVALID_ARCHETYPE = { ...VALID, archetype: 'xyzzy-nonsense' }

/** 範囲外のパラメータ */
const OUT_OF_RANGE = { ...VALID, count: 99 }

/** 応答を順に返すモックモデル。呼ばれたプロンプトを記録する。 */
function mockModel(responses: Array<object | Error>) {
  const prompts: string[] = []
  let call = 0
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt))
      const next = responses[Math.min(call, responses.length - 1)]
      call++
      if (next instanceof Error) throw next
      return {
        // AI SDK v6 の finishReason は文字列ではなく { unified, raw }
        // AI SDK v6 では finishReason も usage も文字列/数値ではなく構造体
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
          totalTokens: 2,
        },
        content: [{ type: 'text' as const, text: JSON.stringify(next) }],
        warnings: [],
      }
    },
  })
  return { model, prompts, callCount: () => call }
}

describe('designLogo の修復リトライ', () => {
  it('スキーマ検証に落ちても再試行し、次が通れば成功する', async () => {
    const { model, prompts, callCount } = mockModel([INVALID_ARCHETYPE, VALID])
    const outcome = await designLogo('テスト', model)

    expect(callCount()).toBe(2)
    expect(outcome.result.built.parts.length).toBeGreaterThan(0)
    // 1 回目の失敗が attempts に記録され、修復プロンプトに反映されている
    expect(outcome.attempts[0].problems.join()).toContain('スキーマ')
    expect(prompts[1]).toContain('直前の出力に次の問題がありました')
  })

  it('パラメータが範囲外でも再試行して回復する', async () => {
    const { model, callCount } = mockModel([OUT_OF_RANGE, VALID])
    const outcome = await designLogo('テスト', model)

    expect(callCount()).toBe(2)
    expect(outcome.attempts[0].problems.length).toBeGreaterThan(0)
    expect(outcome.attempts.at(-1)?.problems).toEqual([])
  })

  it('妥当な計画からは必ず幾何の破綻しない設計が出る', async () => {
    // アーキタイプ方式の要点。モデルが型を選べさえすれば、幾何は保証される。
    const { model } = mockModel([VALID])
    const outcome = await designLogo('テスト', model)
    expect(outcome.result.warnings).toEqual([])
    expect(outcome.result.constraintErrors).toEqual([])
    expect(outcome.result.built.unrelated).toEqual([])
    expect(outcome.result.built.collapsedTo).toBeNull()
  })

  it('毎回スキーマに落ちるなら DESIGN_STRUCTURE_FAILED で終わる', async () => {
    const { model, callCount } = mockModel([INVALID_ARCHETYPE])
    await expect(designLogo('テスト', model)).rejects.toMatchObject({
      code: 'DESIGN_STRUCTURE_FAILED',
    })
    // MAX_ATTEMPTS まで試して諦める
    expect(callCount()).toBe(3)
  })

  it('認証エラーは再試行せず即座に投げ直す', async () => {
    const authError = Object.assign(new Error('Unauthorized'), {
      name: 'AI_APICallError',
      statusCode: 401,
    })
    const { model, callCount } = mockModel([authError])

    await expect(designLogo('テスト', model)).rejects.toThrow('Unauthorized')
    expect(callCount()).toBe(1)
  })

  it('一発で通れば 1 回しか呼ばない', async () => {
    const { model, callCount } = mockModel([VALID])
    const outcome = await designLogo('テスト', model)
    expect(callCount()).toBe(1)
    expect(outcome.attempts).toHaveLength(1)
    expect(outcome.attempts[0].problems).toEqual([])
  })
})

describe('プロンプトとスキーマの整合', () => {
  /**
   * スキーマを平坦化した後もプロンプトが params 入れ子を指示したままで、
   * 毎回 1 回目の生成が検証に落ちていた（＝API コストが常に 2 倍）。
   * 型検査では捕まらないので、プロンプト中の出力例を実際に検証する。
   */
  it('プロンプトの出力例が designPlanSchema をそのまま通る', () => {
    const start = SYSTEM_PROMPT.indexOf('{')
    const end = SYSTEM_PROMPT.lastIndexOf('}')
    expect(start).toBeGreaterThan(-1)

    const example = JSON.parse(SYSTEM_PROMPT.slice(start, end + 1))
    expect(() => designPlanSchema.parse(example)).not.toThrow()
  })

  it('プロンプトが実在するアーキタイプだけを提示している', () => {
    for (const id of ARCHETYPES) expect(SYSTEM_PROMPT).toContain(id)
  })
})

describe('describeValidationFailure', () => {
  it('zod の issues を path つきで平文化する', () => {
    const err = {
      name: 'TypeValidationError',
      cause: {
        issues: [
          { path: ['palette', 'primary'], message: '色は #rgb / #rrggbb 形式のみ' },
          { path: ['shapes', 0, 'r'], message: 'Too big' },
        ],
      },
    }
    const text = describeValidationFailure(err)
    expect(text).toContain('palette.primary')
    expect(text).toContain('shapes.0.r')
  })

  it('issues が無ければメッセージにフォールバックする', () => {
    expect(describeValidationFailure(new Error('boom'))).toBe('boom')
  })
})
