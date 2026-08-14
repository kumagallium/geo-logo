import { describe, expect, it } from 'vitest'
import { compile } from './index'
import { renderPoster, wrapText } from './poster'

const DESIGN = {
  name: 'テストマーク',
  concept: '2 円の交差で葉を作り、黄金比で刻んだ。',
  module: 64,
  grid: 'golden' as const,
  palette: {
    primary: '#111111',
    secondary: '#8A8A8A',
    accent: '#C2410C',
    background: '#FFFFFF',
  },
  shapes: [
    { kind: 'circle' as const, id: 'a', cx: -1, cy: 0, r: 3 },
    { kind: 'circle' as const, id: 'b', cx: 1, cy: 0, r: 3 },
  ],
  constraints: [],
  groups: [],
  parts: [
    {
      id: 'mark',
      steps: [
        { op: 'add' as const, ref: 'a' },
        { op: 'intersect' as const, ref: 'b' },
      ],
      fill: 'primary' as const,
      mirror: 'none' as const,
    },
  ],
}

describe('wrapText', () => {
  it('表示幅で折り返す（全角 1・半角 0.5）', () => {
    const lines = wrapText('あいうえおかきくけこ', 5)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(6)
  })

  it('英字は単語の途中で切らない', () => {
    const lines = wrapText('alpha bravo charlie delta echo foxtrot', 12)
    // 語が分断されていない＝連結すると元に戻る
    const joined = lines.join(' ').replace(/\s+/g, ' ').trim()
    expect(joined).toBe('alpha bravo charlie delta echo foxtrot')
  })

  it('行頭に句読点や閉じ括弧を残さない', () => {
    // 折り返し位置がちょうど句点に当たるように長さを選ぶ
    const lines = wrapText('あいうえお。かきくけこ。さしすせそ。', 5)
    for (let i = 1; i < lines.length; i++) {
      expect('、。）」'.includes(lines[i][0])).toBe(false)
    }
  })

  it('行数の上限を超えたら省略記号で打ち切る', () => {
    const lines = wrapText('あ'.repeat(200), 10, 3)
    expect(lines).toHaveLength(3)
    expect(lines[2].endsWith('…')).toBe(true)
  })

  it('空文字なら空配列', () => {
    expect(wrapText('', 10)).toEqual([])
  })
})

describe('renderPoster', () => {
  it('XML として妥当な 1 枚の紙面を返す', () => {
    const r = compile(DESIGN)
    const svg = r.posterSvg

    expect(svg.startsWith('<svg')).toBe(true)
    // 開いたタグと閉じたタグの数が一致する（属性が壊れていない粗い検査）
    const opens = (svg.match(/<svg[\s>]/g) ?? []).length
    const closes = (svg.match(/<\/svg>/g) ?? []).length
    expect(opens).toBe(closes)
    // 完成ロゴと設計図が入れ子で載っている（見出し・下段・作図面の 3 つ）
    expect(opens).toBeGreaterThanOrEqual(4)
  })

  it('設計名と設計意図が紙面に出る', () => {
    const svg = compile(DESIGN).posterSvg
    expect(svg).toContain('テストマーク')
    expect(svg).toContain('黄金比')
    expect(svg).toContain('CONCEPT')
  })

  it('文字列に含まれる山括弧とアンパサンドを逃がす', () => {
    // 紙面のテキストは LLM 由来なので、そのまま出すとマークアップを壊せる
    const svg = renderPoster(
      { ...DESIGN, name: '<script>x</script>', concept: 'a & b <c>' } as never,
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('a &amp; b')
  })

  it('見出しの名前を差し替えられる', () => {
    const svg = renderPoster(DESIGN as never, '<svg ></svg>', '<svg ></svg>', {
      wordmark: 'Studio Kumagai',
    })
    expect(svg).toContain('Studio Kumagai')
  })
})
