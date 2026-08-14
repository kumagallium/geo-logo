import { build, type BuildResult } from './build'
import { designSchema, type LogoDesign } from './dsl'
import { checkConstraints, normalize, type NormalizeNote } from './normalize'
import { renderPoster, type PosterOptions } from './poster'
import { renderBlueprint, renderLogo, type RenderOptions } from './render'

export * from './dsl'
export * from './units'
export { build } from './build'
export type { BuildResult, BuiltPart, ConstructionItem, Bounds } from './build'
export { normalize, checkConstraints } from './normalize'
export type { NormalizeNote, NormalizeResult } from './normalize'
export { renderLogo, renderBlueprint } from './render'
export { renderPoster, wrapText } from './poster'
export type { PosterOptions } from './poster'
export type { RenderOptions } from './render'
export { samples, sampleByName } from './samples'

export type CompileResult = {
  design: LogoDesign
  built: BuildResult
  logoSvg: string
  /** 完成ロゴ・設計図・設計意図を 1 枚にまとめた作図シート */
  posterSvg: string
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
export function compile(
  input: unknown,
  options: RenderOptions & PosterOptions = {},
): CompileResult {
  const parsed = designSchema.parse(input)
  const { design, notes, unresolved } = normalize(parsed)
  const built = build(design)
  const logoSvg = renderLogo(design, built, options)
  const blueprintSvg = renderBlueprint(design, built, options)
  // 紙面用は地と方眼を落とした別テーマで描く。同じ幾何データから 2 通りに出す
  const sheetBlueprint = renderBlueprint(design, built, { ...options, theme: 'sheet' })
  const constraintErrors = checkConstraints(design)

  return {
    design,
    built,
    logoSvg,
    blueprintSvg,
    posterSvg: renderPoster(design, logoSvg, sheetBlueprint, options),
    notes,
    warnings: [...unresolved, ...built.warnings],
    constraintErrors,
  }
}
