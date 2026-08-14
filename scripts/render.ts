/**
 * 計画 1 件を描いて、警告と注記を全部見る。
 *
 *   pnpm tsx scripts/render.ts plan.json 出力名
 *
 * 経路ごとに render-composition / render-emblem と道具が分かれていたが、
 * 種類は計画の形から分かるので 1 本で足りる。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { diagnose } from '../src/lib/design-agent.js'
import { toDesign } from './plan.js'

const [file, out = 'one'] = process.argv.slice(2)
const result = compile(toDesign(JSON.parse(readFileSync(file, 'utf8'))))

mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)
writeFileSync(`tmp/${out}-poster.svg`, result.posterSvg)

console.log(formatMetrics(measure(result.design, result.built)))
console.log(`潰れ: ${result.built.collapsedTo ?? 'なし'}`)
for (const w of result.warnings) console.log(`  警告 ${w}`)
for (const e of result.constraintErrors) console.log(`  制約 ${e}`)
for (const p of diagnose(result)) console.log(`  診断 ${p.split('\n')[0]}`)
