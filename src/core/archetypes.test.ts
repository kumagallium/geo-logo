import { describe, expect, it } from 'vitest'
import {
  ARCHETYPES,
  ARCHETYPE_FAMILIES,
  RATIOS,
  WEIGHTS,
  buildFromArchetype,
  resolveArchetype,
  resolveEnclosure,
  type ArchetypeParams,
} from './archetypes'
import { compile } from './index'
import { diagnose } from '../lib/design-agent'

/**
 * アーキタイプの狙いは「モデルが何を選んでも幾何が破綻しない」こと。
 * したがって、意味のあるパラメータ空間を総当たりして、すべてが
 * 品質判定（design-agent の diagnose）を通ることを保証する必要がある。
 * ここが通る限り、生成の品質はモデルの賢さに依存しない。
 */

function paramGrid(): ArchetypeParams[] {
  const out: ArchetypeParams[] = []
  for (const archetype of ARCHETYPES) {
    for (const ratio of RATIOS) {
      for (const weight of WEIGHTS) {
        for (const count of [2, 5, 8]) {
          for (const span of [45, 180, 330]) {
            for (const orientation of [0, 90, 180]) {
              for (const accent of [false, true]) {
                out.push({ archetype, ratio, weight, count, span, orientation, accent, enclosure: 'none', repeat: 1 })
              }
            }
          }
        }
      }
    }
  }
  return out
}

describe('アーキタイプ', () => {
  const grid = paramGrid()

  it(`パラメータ全組み合わせ（${grid.length} 通り）で幾何が破綻しない`, () => {
    const failures: string[] = []

    for (const params of grid) {
      const design = buildFromArchetype({
        name: 'Test',
        concept: 'test',
        params,
      })
      let problems: string[]
      try {
        problems = diagnose(compile(design))
      } catch (err) {
        problems = [`例外: ${err instanceof Error ? err.message : String(err)}`]
      }
      if (problems.length > 0) {
        failures.push(
          `${params.archetype} ratio=${params.ratio} weight=${params.weight} ` +
            `count=${params.count} span=${params.span} rot=${params.orientation} ` +
            `accent=${params.accent}\n    → ${problems.join(' / ')}`,
        )
      }
    }

    // 失敗が出たら最初の 10 件を見せる（全部出すと読めない）
    expect(failures.slice(0, 10).join('\n  ')).toBe('')
    expect(failures).toHaveLength(0)
    // 総当たりでブーリアン演算を回すため既定の 5 秒では足りない
  }, 180_000)

  it('各アーキタイプが実際に異なる形を作る（型が名ばかりでないこと）', () => {
    const base: Omit<ArchetypeParams, 'archetype'> = {
      ratio: 'golden',
      weight: 'regular',
      count: 3,
      span: 180,
      orientation: 0,
      accent: false,
      enclosure: 'none',
      repeat: 1,
    }
    const signatures = new Set<string>()
    for (const archetype of ARCHETYPES) {
      const built = compile(buildFromArchetype({ name: 'x', concept: 'x', params: { ...base, archetype } }))
      // パスデータの長さと外接矩形で粗く同定する
      const sig = `${built.built.parts[0]?.pathData.length}:${built.built.artBounds.width.toFixed(1)}x${built.built.artBounds.height.toFixed(1)}`
      signatures.add(sig)
    }
    expect(signatures.size).toBe(ARCHETYPES.length)
  })

  it('accent 指定で副要素が別の色のパーツに分かれる', () => {
    const design = buildFromArchetype({
      name: 'x',
      concept: 'x',
      params: {
        archetype: 'leaf-stem',
        ratio: 'golden',
        weight: 'regular',
        enclosure: 'none',
        repeat: 1,
        count: 3,
        span: 90,
        orientation: 0,
        accent: true,
      },
    })
    expect(design.parts).toHaveLength(2)
    const fills = new Set(compile(design).built.parts.map((p) => p.fill))
    expect(fills.size).toBe(2)
  })
})

describe('resolveArchetype', () => {
  it('正規の名前をそのまま通す', () => {
    for (const id of ARCHETYPES) expect(resolveArchetype(id)).toBe(id)
  })

  it('モデルが出しがちな別名を寄せる（実測で初回失敗の原因だった）', () => {
    expect(resolveArchetype('wave')).toBe('concentric-arcs')
    expect(resolveArchetype('Ripple')).toBe('concentric-arcs')
    expect(resolveArchetype('vesica')).toBe('leaf')
    expect(resolveArchetype('crescent')).toBe('bitten')
    expect(resolveArchetype('flower')).toBe('rosette')
    expect(resolveArchetype('bridge')).toBe('arch')
  })

  it('表記ゆれ（空白・アンダースコア・大文字）を吸収する', () => {
    expect(resolveArchetype('leaf stem')).toBe('leaf-stem')
    expect(resolveArchetype('LEAF_STEM')).toBe('leaf-stem')
    expect(resolveArchetype('concentric arcs')).toBe('concentric-arcs')
    expect(resolveArchetype('ringgap')).toBe('ring-gap')
  })

  it('解決できないものは null を返す', () => {
    expect(resolveArchetype('完全に無関係な語')).toBeNull()
    expect(resolveArchetype('xyzzy')).toBeNull()
  })
})

describe('ARCHETYPE_FAMILIES', () => {
  /**
   * 型を追加したのに系統へ入れ忘れると、その型は候補生成で一度も選ばれない
   * （候補は必ず系統を割り当てて生成するため）。実装したのに出てこない、という
   * 気づきにくい欠落になるので、分割が全体をちょうど覆うことを検査する。
   */
  it('全アーキタイプを重複なく覆う', () => {
    const members = ARCHETYPE_FAMILIES.flatMap((f) => f.members)
    expect(new Set(members).size).toBe(members.length)
    expect([...members].sort()).toEqual([...ARCHETYPES].sort())
  })

  it('空の系統がない', () => {
    for (const f of ARCHETYPE_FAMILIES) expect(f.members.length).toBeGreaterThan(0)
  })
})

describe('囲いと反復', () => {
  // 型はモチーフでしかない。囲いと反復が付いて初めて紋になるので、
  // どの型でもこの二つが壊れずに効くことを担保する。
  const base: Omit<ArchetypeParams, 'archetype' | 'enclosure' | 'repeat'> = {
    ratio: 'golden',
    weight: 'regular',
    count: 3,
    span: 180,
    orientation: 0,
    accent: false,
  }

  it('どの型でも囲い・反復の組み合わせが図形を壊さない', () => {
    const failures: string[] = []
    for (const archetype of ARCHETYPES) {
      for (const enclosure of ['none', 'ring', 'double'] as const) {
        for (const repeat of [1, 3, 4] as const) {
          const label = `${archetype}/${enclosure}/${repeat}`
          try {
            const r = compile(
              buildFromArchetype({
                name: 'x',
                concept: 'x',
                params: { ...base, archetype, enclosure, repeat },
              }),
            )
            const ink = r.built.parts.reduce((n, p) => n + p.pathData.length, 0)
            if (ink === 0) failures.push(`${label}: 空`)
            // 囲いを付けたら、それが最大寸法でなければならない（溢れていない）
            if (enclosure !== 'none') {
              const { width, height } = r.built.artBounds
              const ratio = Math.max(width, height) / Math.min(width, height)
              if (ratio > 1.02) failures.push(`${label}: 輪から溢れている（${ratio.toFixed(2)}）`)
            }
          } catch (err) {
            failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }
    expect(failures.join('\n  ')).toBe('')
  }, 120_000)

  it('反復すると図形が増える（手順を並べただけで消えていない）', () => {
    const one = compile(
      buildFromArchetype({
        name: 'x',
        concept: 'x',
        params: { ...base, archetype: 'leaf', enclosure: 'none', repeat: 1 },
      }),
    )
    const three = compile(
      buildFromArchetype({
        name: 'x',
        concept: 'x',
        params: { ...base, archetype: 'leaf', enclosure: 'none', repeat: 3 },
      }),
    )
    // intersect は積み上がった図形に効くので、単純に手順を並べると
    // 2 つ目のコピーが 1 つ目を削って形が消える。パーツを分けて防いでいる
    expect(three.built.parts.length).toBe(3)
    expect(one.built.parts.length).toBe(1)
    expect(three.built.artBounds.width).toBeGreaterThan(one.built.artBounds.width)
  })
})

describe('囲いの名前解決', () => {
  // 完全一致だけを見て外れたら "none" に倒していた。すると「方形フレーム」
  // という名前の案から囲いが消え、名前だけ残って形が伴わなくなる。
  it('綴りや言い方の違いを正規の値へ寄せる', () => {
    const cases: Array<[string, string]> = [
      ['ring', 'ring'],
      ['circle', 'ring'],
      ['丸', 'ring'],
      ['double-ring', 'double'],
      ['二重丸', 'double'],
      ['hexagon', 'hex'],
      ['亀甲', 'hex'],
      ['honeycomb', 'hex'],
      ['square', 'square'],
      ['box', 'square'],
      ['正方形', 'square'],
      ['方形フレーム', 'square'],
      ['rhombus', 'diamond'],
      ['隅立て角', 'diamond'],
      ['none', 'none'],
      ['', 'none'],
    ]
    const wrong = cases.filter(([input, want]) => resolveEnclosure(input) !== want)
    expect(wrong.map(([i, w]) => `${i} → ${resolveEnclosure(i)}（期待 ${w}）`)).toEqual([])
  })

  it('square と diamond は別の形になる（向きが違う）', () => {
    const of = (enclosure: 'square' | 'diamond') =>
      compile(
        buildFromArchetype({
          name: 'x',
          concept: 'x',
          params: {
            archetype: 'leaf',
            ratio: 'golden',
            weight: 'regular',
            count: 3,
            span: 180,
            orientation: 0,
            accent: false,
            enclosure,
            repeat: 1,
          },
        }),
      ).built.parts.map((p) => p.pathData).join('')
    expect(of('square')).not.toBe(of('diamond'))
  })
})
