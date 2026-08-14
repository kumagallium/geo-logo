import { describe, expect, it } from 'vitest'
import type { Composition } from '../core/composition'
import { applyPatch, patchSchema, redrawPrompt, revisePrompt } from './refine-agent'

const plan: Composition = {
  name: 'T',
  concept: 'c',
  ratio: 'golden',
  pieces: [
    { label: '頭', form: 'disc', role: 'add', x: 0, y: 0, size: 2, angle: 0, span: 180, thickness: 'regular', mirror: false },
    { label: '耳', form: 'disc', role: 'add', x: 2, y: -1, size: 0.6, angle: 0, span: 180, thickness: 'regular', mirror: true },
    { label: '目', form: 'disc', role: 'cut', x: 0.8, y: -0.4, size: 0.3, angle: 0, span: 180, thickness: 'regular', mirror: true },
  ],
}

const patch = (o: unknown) => patchSchema.parse(o)

describe('applyPatch', () => {
  /**
   * 設計を丸ごと返させると、指示しても毎回すべて書き直され、できていた部分まで
   * 壊れる（実測: 眉の隆起が出た次の回で目が消えた）。差分なら触れない部品は残る。
   */
  it('触れられなかった部品はそのまま残る', () => {
    const next = applyPatch(plan, patch({ edits: [{ index: 0, size: 2.4 }] }))
    expect(next.pieces[0].size).toBe(2.4)
    expect(next.pieces[1]).toEqual(plan.pieces[1])
    expect(next.pieces[2]).toEqual(plan.pieces[2])
  })

  it('渡さなかった項目は元の値を保つ', () => {
    const next = applyPatch(plan, patch({ edits: [{ index: 1, y: 0.5 }] }))
    expect(next.pieces[1].y).toBe(0.5)
    expect(next.pieces[1].x).toBe(2)
    expect(next.pieces[1].mirror).toBe(true)
  })

  it('部品を消せる', () => {
    const next = applyPatch(plan, patch({ edits: [{ index: 2, remove: true }] }))
    expect(next.pieces).toHaveLength(2)
  })

  it('すべて消す指示は受け付けない', () => {
    // 空の設計は形を生まない。輪を止めないために元の設計を残す
    const next = applyPatch(plan, patch({ edits: [0, 1, 2].map((index) => ({ index, remove: true })) }))
    expect(next.pieces.length).toBeGreaterThan(0)
  })

  it('存在しない番号は黙って無視する', () => {
    const next = applyPatch(plan, patch({ edits: [{ index: 99, size: 5 }] }))
    expect(next.pieces).toEqual(plan.pieces)
  })

  it('部品を足せる', () => {
    const next = applyPatch(
      plan,
      patch({ edits: [], add: [{ form: 'disc', role: 'add', x: 0, y: 2, size: 1 }] }),
    )
    expect(next.pieces).toHaveLength(4)
  })
})

describe('直しの指示', () => {
  const c = { reads: 'クマに見える', score: 4, fix: '口を横長にする' }

  it('差分の指示には部品の一覧と番号が入る', () => {
    const text = revisePrompt('ゴリラ', plan, c)
    expect(text).toContain('0: 頭')
    expect(text).toContain('2: 目')
    expect(text).toContain('口を横長にする')
  })

  it('描き直しの指示には現在の設計と講評が入る', () => {
    const text = redrawPrompt('ゴリラ', plan, c)
    expect(text).toContain('ゴリラ')
    expect(text).toContain('クマに見える')
    expect(text).toContain('4 / 10')
  })
})
