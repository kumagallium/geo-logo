/**
 * 節点の並びを描いて確かめる道具。
 *   pnpm tsx scripts/render-emblem.ts path/to/emblem.json 出力名
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildFromEmblem, distinctRadii } from '../src/core/emblem.js'
import { compile } from '../src/core/index.js'
import { diagnose } from '../src/lib/design-agent.js'

const [file, out = 'emblem'] = process.argv.slice(2)
const design = buildFromEmblem(JSON.parse(readFileSync(file, 'utf8')))
const result = compile(design)

mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)
writeFileSync(`tmp/${out}-poster.svg`, result.posterSvg)

const problems = diagnose(result)
console.log(
  `${out}: 円 ${design.shapes.length} / 異なる半径 ${distinctRadii(design)} 種 / ` +
    `インク ${(result.built.inkRatio * 100).toFixed(0)}% / ${problems.length === 0 ? '問題なし' : problems[0].split('\n')[0]}`,
)
