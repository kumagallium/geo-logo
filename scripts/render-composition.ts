/**
 * 手書きの部品構成を描いて確かめるための道具。
 *   pnpm tsx scripts/render-composition.ts path/to/composition.json out-name
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { buildFromComposition } from '../src/core/composition.js'
import { compile } from '../src/core/index.js'
import { diagnose } from '../src/lib/design-agent.js'

const [file, out = 'comp'] = process.argv.slice(2)
const plan = JSON.parse(readFileSync(file, 'utf8'))
const result = compile(buildFromComposition(plan))
const problems = diagnose(result)

mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)

console.log(`${plan.name}: shapes ${result.design.shapes.length} / インク ${(result.built.inkRatio * 100).toFixed(0)}%`)
console.log(problems.length === 0 ? '問題なし' : problems.map((p) => `  - ${p.split('\n')[0]}`).join('\n'))
