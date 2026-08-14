import { describe, expect, it } from 'vitest'
import {
  ARCHETYPES,
  ARCHETYPE_FAMILIES,
  RATIOS,
  WEIGHTS,
  buildFromArchetype,
  resolveArchetype,
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
                out.push({ archetype, ratio, weight, count, span, orientation, accent })
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
