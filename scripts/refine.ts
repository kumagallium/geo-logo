/**
 * 引いて、見て、直す。視覚モデルの講評を次の作図へ戻して繰り返す。
 *
 *   pnpm refine "ゴリラ" [回数]
 *
 * 各回の完成形と設計図を tmp/ へ出す。
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { rasterize } from '../src/core/raster.js'
import { createModel } from '../src/lib/create-model.js'
import { refineLogo } from '../src/lib/refine-agent.js'
import { fromEnv } from '../src/server/config/resolve-model.js'

const brief = process.argv[2] ?? 'ゴリラ'
const rounds = Number(process.argv[3] ?? 4)

const config = fromEnv()
if (!config?.apiKey || !config.apiBase) {
  console.error('.env の GEOLOGO_* を設定してください')
  process.exit(1)
}

mkdirSync('tmp', { recursive: true })
const outcome = await refineLogo(
  brief,
  createModel(config),
  {
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    model: process.env.GEOLOGO_VISION ?? 'preview/Qwen3-VL-30B-A3B-Instruct',
  },
  {
    maxRounds: rounds,
    revise: process.env.GEOLOGO_REVISE === 'patch' ? 'patch' : 'redraw',
    onRound: (r) => {
      const tag = `refine${r.index + 1}`
      writeFileSync(`tmp/${tag}-logo.svg`, r.result.logoSvg)
      writeFileSync(`tmp/${tag}-blueprint.svg`, r.result.blueprintSvg)
      writeFileSync(`tmp/${tag}.png`, rasterize(r.result.built, { size: 320 }))
      console.log(`第 ${r.index + 1} 回: ${r.critique.score}/10 「${r.critique.reads}」`)
      if (r.critique.fix) console.log(`   → ${r.critique.fix}`)
    },
  },
)

console.log('---')
console.log(`最良: 第 ${outcome.best.index + 1} 回 / ${outcome.best.critique.score} 点`)
writeFileSync('tmp/refine-best-logo.svg', outcome.best.result.logoSvg)
writeFileSync('tmp/refine-best-poster.svg', outcome.best.result.posterSvg)
