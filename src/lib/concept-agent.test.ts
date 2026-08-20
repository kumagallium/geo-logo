import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { generateImageConcepts, refineImageConcept } from './concept-agent'

/**
 * generateObject はプロンプト文中で JSON のキー名を明示していないと、
 * モデルが別の名前を推測して**スキーマと一致しない JSON**を返すことがある
 * （実測: gemma-4-31B が visual を prompt というキーで返し、refine が毎回
 * 黙って brief へフォールバックしていた——「指示が効かない」の正体だった）。
 * ここではプロンプト文にキー名が現れることを固定する。
 */

/** 応答を 1 回返すモックモデル */
function mockModel(response: object) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
        totalTokens: 2,
      },
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      warnings: [],
    }),
  })
}

describe('refineImageConcept', () => {
  it('視覚記述を書き直す', async () => {
    const model = mockModel({
      visual: 'A stern bear face silhouette, brow furrowed, mouth tight.',
    })
    const result = await refineImageConcept(
      'A calm bear face silhouette, mouth relaxed.',
      '厳しい表情に',
      model,
    )
    expect(result).toBe('A stern bear face silhouette, brow furrowed, mouth tight.')
  })

  it('プロンプトにスキーマのキー名（visual）が明示されている', async () => {
    // モデルは文中に現れた名前をキーとして使う傾向がある。ここが抜けると
    // 「prompt」のような別名で返し、スキーマ不一致で黙って失敗する
    let seenPrompt = ''
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seenPrompt = JSON.stringify(options.prompt)
        return {
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
            totalTokens: 2,
          },
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ visual: 'A stern bear face silhouette on white.' }),
            },
          ],
          warnings: [],
        }
      },
    })
    await refineImageConcept('A calm bear face.', '厳しい表情に', model)
    expect(seenPrompt).toContain('visual')
  })
})

describe('generateImageConcepts', () => {
  it('4 案のうちちょうど 1 案が brush になるようプロンプトが指示する', async () => {
    let seenPrompt = ''
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seenPrompt = JSON.stringify(options.prompt)
        const concepts = Array.from({ length: 4 }, (_, i) => ({
          title: `案${i}`,
          visual: 'A single flat vector-style mark, solid black silhouette on white.',
          rationale: '熊の性格を眼鏡で表現する案です。',
          treatment: i === 0 ? 'brush' : 'flat',
          symmetry: 'mirror',
        }))
        return {
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
            totalTokens: 2,
          },
          content: [{ type: 'text' as const, text: JSON.stringify({ concepts }) }],
          warnings: [],
        }
      },
    })
    const concepts = await generateImageConcepts('落ち着いた熊', model, 4)
    expect(concepts.filter((c) => c.treatment === 'brush')).toHaveLength(1)
    expect(seenPrompt).toContain('visual')
    expect(seenPrompt).toContain('symmetry')
  })
})
