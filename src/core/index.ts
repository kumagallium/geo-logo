import { build, type BuildResult } from './build'
import { designSchema, type LogoDesign } from './dsl'
import { checkConstraints, normalize, type NormalizeNote } from './normalize'
import { renderBlueprint, renderLogo, type RenderOptions } from './render'

export * from './dsl'
export * from './units'
export { build } from './build'
export type { BuildResult, BuiltPart, ConstructionItem, Bounds } from './build'
export { normalize, checkConstraints } from './normalize'
export type { NormalizeNote, NormalizeResult } from './normalize'
export { renderLogo, renderBlueprint } from './render'
export type { RenderOptions } from './render'
export { samples, sampleByName } from './samples'

export type CompileResult = {
  design: LogoDesign
  built: BuildResult
  logoSvg: string
  blueprintSvg: string
  notes: NormalizeNote[]
  warnings: string[]
  constraintErrors: string[]
}

/**
 * DSL → 正規化 → ブーリアン → 2 種の SVG。
 *
 * 完成ロゴと設計図が同一の中間表現から出るので、設計図は事後の飾りではなく
 * 実際に使われた作図そのものになる。
 */
export function compile(input: unknown, options: RenderOptions = {}): CompileResult {
  const parsed = designSchema.parse(input)
  const { design, notes, unresolved } = normalize(parsed)
  const built = build(design)
  const constraintErrors = checkConstraints(design)

  return {
    design,
    built,
    logoSvg: renderLogo(design, built, options),
    blueprintSvg: renderBlueprint(design, built, options),
    notes,
    warnings: [...unresolved, ...built.warnings],
    constraintErrors,
  }
}
