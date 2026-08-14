/**
 * 候補 4 件を系統ごとに割り当てて生成し、構成が実際に分かれるかを見る煙試験。
 *
 *   pnpm tsx scripts/smoke-candidates.ts "海洋データのスタートアップ"
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createModel } from '../src/lib/create-model.js'
import { designLogo, modeForVariant } from '../src/lib/design-agent.js'
import { fromEnv } from '../src/server/config/resolve-model.js'

const brief = process.argv.slice(2).join(' ') || '海洋データを扱うスタートアップのマーク'
const config = fromEnv()
if (!config?.apiKey) {
  console.error('.env の GEOLOGO_* が未設定です。')
  process.exit(1)
}
const model = createModel(config)

mkdirSync('tmp', { recursive: true })
const COUNT = Number(process.env.GEOLOGO_CANDIDATES ?? 4)
const results = await Promise.all(
  Array.from({ length: COUNT }, async (_, i) => {
    const mode = modeForVariant(i)
    const label =
      mode.kind === 'archetype'
        ? `型:${mode.family?.name ?? '自由'}`
        : mode.kind === 'outline'
          ? '輪郭'
          : `部品:${mode.angle}`
    try {
      const o = await designLogo(brief, model, mode)
      writeFileSync(`tmp/run${i + 1}-logo.svg`, o.result.logoSvg)
      writeFileSync(`tmp/run${i + 1}-blueprint.svg`, o.result.blueprintSvg)
      writeFileSync(`tmp/run${i + 1}-poster.svg`, o.result.posterSvg)
      return `#${i + 1} ${label}
     試行${o.attempts.length} / ${o.result.design.name} / shapes ${o.result.design.shapes.length} / 問題 ${o.attempts.at(-1)?.problems.length}`
    } catch (err) {
      return `#${i + 1} ${label} … 失敗: ${err instanceof Error ? err.message.slice(0, 80) : err}`
    }
  }),
)
console.log(`brief: ${brief}`)
for (const r of results) console.log(r)
