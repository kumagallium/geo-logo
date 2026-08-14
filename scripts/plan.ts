import { buildFromArchetype } from '../src/core/archetypes.js'
import { buildFromComposition } from '../src/core/composition.js'
import { buildFromEmblem } from '../src/core/emblem.js'
import { buildFromFigure } from '../src/core/figure.js'
import type { LogoDesign } from '../src/core/index.js'
import { buildFromOutline } from '../src/core/outline.js'

/**
 * JSON がどの経路の計画かを鍵の有無で見分ける。
 *
 * 経路が 5 本あるので、道具ごとに `--kind` を渡すのは面倒だし間違える。
 * 計画の形そのものが種類を語っているので、それを読む。
 */
export function toDesign(plan: Record<string, unknown>): LogoDesign {
  if (Array.isArray(plan.pieces)) return buildFromComposition(plan as never)
  if (Array.isArray(plan.contours)) return buildFromOutline(plan as never)
  if (Array.isArray(plan.nodes)) {
    // 節点方式は輪の並び（rings）を持つ。関係方式は持たない
    const first = plan.nodes[0] as Record<string, unknown> | undefined
    return first && Array.isArray(first.rings)
      ? buildFromEmblem(plan as never)
      : buildFromFigure(plan as never)
  }
  if (typeof plan.archetype === 'string') return buildFromArchetype(plan as never)
  return plan as unknown as LogoDesign
}
