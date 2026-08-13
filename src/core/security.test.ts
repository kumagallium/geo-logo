import { describe, expect, it } from 'vitest'
import { compile } from './index'
import { designSchema } from './dsl'
import { samples } from './samples'

/**
 * SVG は dangerouslySetInnerHTML でページへ注入されるため、
 * LLM 由来の文字列が属性やタグを抜け出せてはいけない。
 *
 * 静的モードでは API キーが同一オリジンの localStorage にあるので、
 * ここでの XSS はそのままキー漏洩につながる。最優先で塞ぐ対象。
 */

const base = {
  name: 'x',
  concept: 'x',
  module: 64,
  grid: 'golden' as const,
  shapes: [{ kind: 'circle' as const, id: 'a', cx: 0, cy: 0, r: 2 }],
  constraints: [],
  groups: [],
  parts: [{ id: 'p', fill: 'primary' as const, mirror: 'none' as const, steps: [{ op: 'add' as const, ref: 'a' }] }],
}

describe('DSL のスキーマ検証（信頼できない入力の遮断）', () => {
  it('palette に色以外の文字列を入れられない', () => {
    const attack = {
      ...base,
      palette: {
        primary: '#000" onload="alert(1)',
        secondary: '#888888',
        accent: '#C2410C',
        background: '#FFFFFF',
      },
    }
    expect(() => designSchema.parse(attack)).toThrow()
  })

  it('palette は #rgb / #rrggbb / #rrggbbaa を受け付ける', () => {
    for (const c of ['#000', '#11223344', '#AbCdEf']) {
      const ok = { ...base, palette: { primary: c, secondary: c, accent: c, background: c } }
      expect(() => designSchema.parse(ok)).not.toThrow()
    }
  })

  it('シェイプ id に markup 由来の文字を入れられない', () => {
    const attack = {
      ...base,
      shapes: [{ kind: 'circle', id: 'a"><script>alert(1)</script>', cx: 0, cy: 0, r: 2 }],
      parts: [{ id: 'p', steps: [{ op: 'add', ref: 'a"><script>alert(1)</script>' }] }],
    }
    expect(() => designSchema.parse(attack)).toThrow()
  })

  it('座標・寸法に極端な値を入れられない（ソルバーとブラウザの DoS 防止）', () => {
    expect(() => designSchema.parse({ ...base, shapes: [{ kind: 'circle', id: 'a', cx: 0, cy: 0, r: 1e9 }] })).toThrow()
    expect(() => designSchema.parse({ ...base, shapes: [{ kind: 'circle', id: 'a', cx: 1e9, cy: 0, r: 1 }] })).toThrow()
    expect(() => designSchema.parse({ ...base, module: 100000 })).toThrow()
    expect(() => designSchema.parse({ ...base, shapes: [{ kind: 'circle', id: 'a', cx: 0, cy: 0, r: Number.NaN }] })).toThrow()
  })

  it('シェイプ数に上限がある', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      kind: 'circle' as const,
      id: `c${i}`,
      cx: 0,
      cy: 0,
      r: 1,
    }))
    expect(() => designSchema.parse({ ...base, shapes: many })).toThrow()
  })
})

describe('SVG 出力のエスケープ', () => {
  it('name / concept が属性やタグを抜け出さない', () => {
    const design = designSchema.parse({
      ...base,
      name: '</title><script>alert(1)</script>',
      concept: '"><img src=x onerror=alert(1)>',
    })
    const { logoSvg, blueprintSvg } = compile(design)
    for (const svg of [logoSvg, blueprintSvg]) {
      expect(svg).not.toContain('<script>')
      expect(svg).not.toContain('onerror=')
      expect(svg).not.toContain('</title><')
    }
  })

  it('正常なサンプルは有効な色だけを出力する', () => {
    for (const sample of samples) {
      const { logoSvg } = compile(sample)
      const fills = [...logoSvg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1])
      for (const f in fills) {
        void f
      }
      for (const fill of fills) {
        expect(fill).toMatch(/^(#[0-9a-fA-F]{3,8}|none|currentColor)$/)
      }
    }
  })
})
