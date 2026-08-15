/**
 * 関係方式を実機で回して、1 枚のシートにまとめる。
 *
 *   pnpm tsx scripts/figures.ts 4 "ヘッドホンをしたパンダ" "トリケラトプスの骨格"
 *
 * 第 1 引数が 1 題材あたりの件数。以降がブリーフ。
 * 生成した計画は tmp/gen/ に残すので、気に入ったものを手で直して比べられる。
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { encodeGrayPng, rasterizeGray } from '../src/core/raster.js'
import { createModel } from '../src/lib/create-model.js'
import { designLogo, diagnose } from '../src/lib/design-agent.js'
import { fromEnv } from '../src/server/config/resolve-model.js'

const [countArg, ...briefs] = process.argv.slice(2)
const per = Number.parseInt(countArg ?? '', 10) || 1
if (briefs.length === 0) {
  console.error('使い方: pnpm tsx scripts/figures.ts <件数> "ブリーフ" ["ブリーフ" ...]')
  process.exit(1)
}

const config = fromEnv()
if (!config?.apiKey) {
  console.error('.env からモデルを解決できません（GEOLOGO_PROVIDER / BASE_URL / API_KEY / MODEL）')
  process.exit(1)
}
const model = createModel(config)
console.log(`model: ${config.modelId}\n`)

mkdirSync('tmp/gen', { recursive: true })

const CELL = 240
const cells: Uint8Array[] = []

// 題材ごとに件数ぶん、同時に投げる。1 件が落ちてもシートは作る
const jobs = briefs.flatMap((brief, b) =>
  Array.from({ length: per }, (_, i) => ({ brief, tag: `g${b}-${i}` })),
)

/**
 * 同時に投げる本数。
 *
 * 9 本まとめて投げたら 4 本が空応答で落ちた（単体では 4/4 成功）。
 * 生成の質とは無関係の失敗で結果が濁るので、絞る。
 */
const LANES = 3

async function run<T, R>(items: T[], lanes: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(lanes, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await f(items[i])
      }
    }),
  )
  return out
}

const results = await run(jobs, LANES, async ({ brief, tag }) => {
    try {
      const t0 = Date.now()
      const outcome = await designLogo(brief, model, { kind: 'figure' })
      return { tag, brief, outcome, ms: Date.now() - t0, error: null as string | null }
    } catch (e) {
      return {
        tag,
        brief,
        outcome: null,
        ms: 0,
        error: e instanceof Error ? e.message.split('\n')[0] : String(e),
      }
    }
  },
)

for (const r of results) {
  if (!r.outcome) {
    cells.push(new Uint8Array(CELL * CELL).fill(230))
    console.log(`${r.tag} ✗ ${r.error}`)
    continue
  }
  const { result } = r.outcome
  cells.push(rasterizeGray(result.built, { size: CELL }).gray)
  writeFileSync(`tmp/gen/${r.tag}.json`, JSON.stringify(r.outcome.plan, null, 2))
  const problems = diagnose(result)
  console.log(
    `${r.tag} ${result.design.name.padEnd(12)} ${formatMetrics(measure(result.design, result.built))}` +
      ` / 試行 ${r.outcome.attempts.length} / ${(r.ms / 1000).toFixed(1)}s`,
  )
  for (const p of problems) console.log(`      ⚠ ${p.split('\n')[0]}`)
}

const cols = Math.max(per, 1)
const rows = Math.ceil(cells.length / cols)
const GAP = 6
const W = cols * CELL + (cols + 1) * GAP
const H = rows * CELL + (rows + 1) * GAP
const sheet = new Uint8Array(W * H).fill(200)
cells.forEach((gray, i) => {
  const x0 = GAP + (i % cols) * (CELL + GAP)
  const y0 = GAP + Math.floor(i / cols) * (CELL + GAP)
  for (let y = 0; y < CELL; y++) {
    sheet.set(gray.subarray(y * CELL, (y + 1) * CELL), (y0 + y) * W + x0)
  }
})
const out = 'tmp/gen/sheet.png'
writeFileSync(out, encodeGrayPng(sheet, W, H))
console.log(`\n${out} ← ${cells.length} 件（1 行 = 1 題材、${cols} 列）`)
