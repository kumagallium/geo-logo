import { describe, expect, it } from 'vitest'
import { buildCritiquePrompt, critique } from './vision'

/** fetch を差し替えて応答を作る */
function mockFetch(body: unknown, ok = true) {
  return async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response
}

const config = { apiBase: 'https://example.test/v1', apiKey: 'x', model: 'm' }
const reply = (content: string) => ({ choices: [{ message: { content } }] })

describe('critique', () => {
  it('JSON をそのまま返してきたとき読める', async () => {
    globalThis.fetch = mockFetch(
      reply('{"reads":"クマに見える","score":4,"fix":"口を横長にする"}'),
    ) as typeof fetch
    const c = await critique(Buffer.from('x'), 'ゴリラ', config)
    expect(c).toMatchObject({ reads: 'クマに見える', score: 4, fix: '口を横長にする' })
  })

  it('前後に説明文が付いていても読める', async () => {
    // 視覚モデルは JSON だけと指示しても文章を添えてくることが多い
    globalThis.fetch = mockFetch(
      reply('はい、評価します。\n```json\n{"reads":"猿","score":6,"fix":"顎を広く"}\n```\n以上です。'),
    ) as typeof fetch
    const c = await critique(Buffer.from('x'), 'ゴリラ', config)
    expect(c.score).toBe(6)
    expect(c.reads).toBe('猿')
  })

  it('点数は 0〜10 に収める', async () => {
    globalThis.fetch = mockFetch(reply('{"reads":"x","score":99,"fix":"y"}')) as typeof fetch
    expect((await critique(Buffer.from('x'), 'ゴリラ', config)).score).toBe(10)
  })

  it('読めない応答でも輪を止めない', async () => {
    // 講評が壊れても 0 点として次の回へ進む。例外で止めると往復が終わる
    globalThis.fetch = mockFetch(reply('評価できませんでした')) as typeof fetch
    const c = await critique(Buffer.from('x'), 'ゴリラ', config)
    expect(c.score).toBe(0)
    expect(c.raw).toContain('評価できません')
  })

  it('HTTP が失敗したら投げる', async () => {
    globalThis.fetch = mockFetch({}, false) as typeof fetch
    await expect(critique(Buffer.from('x'), 'ゴリラ', config)).rejects.toThrow('視覚モデル')
  })
})

describe('buildCritiquePrompt', () => {
  it('主題を差し込む', () => {
    expect(buildCritiquePrompt('ゴリラ')).toContain('「ゴリラ」')
  })
})
