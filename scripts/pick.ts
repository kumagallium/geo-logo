/**
 * 何案かを視覚モデルに見せて、いちばん読めるものを選ぶ。
 *
 *   pnpm tsx scripts/pick.ts "ふくろう" tmp/gen/g3-*.json
 *
 * 総当たりで 2 枚ずつ比べ、勝ち数で順位を付ける。左右の偏りを消すため、
 * 1 組につき入れ替えて 2 回聞き、割れたら引き分けにする。
 *
 * 採点（0〜10）ではなく比較にするのは実測から。焼いた 29 枚を 8 通りの
 * 聞き方で 443 回試したところ、採点は 29 枚中 27 枚が同じ点で判別せず、
 * 比較は正解既知の 13 組で 92% 当てた。
 *
 * Rikyū の出力は選りすぐりが公開されている。こちらは中央値を出しっぱなしに
 * していたので、比較の土俵が不公平だった。これはその片側を埋める道具。
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { encodeGrayPng, rasterize, rasterizeGray } from '../src/core/raster.js'
import { compare } from '../src/lib/vision.js'
import { fromEnv } from '../src/server/config/resolve-model.js'
import { toDesign } from './plan.js'

const [subject, ...files] = process.argv.slice(2)
if (!subject || files.length < 2) {
  console.error('使い方: pnpm tsx scripts/pick.ts "題材" plan1.json plan2.json ...')
  process.exit(1)
}

// 視覚モデルは openai 互換の口を使う。生成用のモデルとは別に選べる
const env = fromEnv()
const apiBase = process.env.GEOLOGO_VISION_BASE ?? env?.apiBase ?? process.env.GEOLOGO_BASE_URL
const apiKey = process.env.GEOLOGO_VISION_KEY ?? process.env.GEOLOGO_API_KEY ?? env?.apiKey
const model = process.env.GEOLOGO_VISION ?? 'preview/Qwen3-VL-30B-A3B-Instruct'
if (!apiBase || !apiKey) {
  console.error('視覚モデルの接続先を解決できません（GEOLOGO_BASE_URL / GEOLOGO_API_KEY）')
  process.exit(1)
}
const config = { apiBase, apiKey, model }

type Entry = { file: string; name: string; png: Buffer; line: string; wins: number }

const entries: Entry[] = []
for (const file of files) {
  try {
    const r = compile(toDesign(JSON.parse(readFileSync(file, 'utf8'))))
    entries.push({
      file,
      name: file.split('/').pop()?.replace(/\.json$/, '') ?? file,
      png: rasterize(r.built, { size: 384 }),
      line: formatMetrics(measure(r.design, r.built)),
      wins: 0,
    })
  } catch (e) {
    console.log(`${file} ✗ ${e instanceof Error ? e.message.split('\n')[0] : e}`)
  }
}
if (entries.length < 2) process.exit(1)

console.log(`題材「${subject}」/ ${entries.length} 案 / 視覚モデル ${model}\n`)

let draws = 0
for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i]
    const b = entries[j]
    // 入れ替えて 2 回。同じ側を選び続けるなら偏りなので引き分けにする
    const [first, second] = await Promise.all([
      compare(a.png, b.png, subject, config),
      compare(b.png, a.png, subject, config),
    ])
    const aWon = (first.winner === 'A' ? 1 : 0) + (second.winner === 'B' ? 1 : 0)
    const bWon = (first.winner === 'B' ? 1 : 0) + (second.winner === 'A' ? 1 : 0)
    if (aWon > bWon) a.wins++
    else if (bWon > aWon) b.wins++
    else draws++
    console.log(
      `  ${a.name} ${aWon}-${bWon} ${b.name}   ${(aWon >= bWon ? first : second).why}`,
    )
  }
}

entries.sort((x, y) => y.wins - x.wins)
console.log(`\n順位（引き分け ${draws} 組）`)
for (const [i, e] of entries.entries()) {
  console.log(`  ${i + 1}. ${e.name.padEnd(12)} ${e.wins} 勝   ${e.line}`)
}

// 選ばれた順に並べたシートを残す。人の目で答え合わせできるように
const CELL = 240
const GAP = 6
const W = entries.length * CELL + (entries.length + 1) * GAP
const H = CELL + GAP * 2
const sheet = new Uint8Array(W * H).fill(200)
entries.forEach((e, i) => {
  const { gray } = rasterizeGray(compile(toDesign(JSON.parse(readFileSync(e.file, 'utf8')))).built, {
    size: CELL,
    samples: 3,
  })
  const x0 = GAP + i * (CELL + GAP)
  for (let y = 0; y < CELL; y++) sheet.set(gray.subarray(y * CELL, (y + 1) * CELL), (GAP + y) * W + x0)
})
writeFileSync('tmp/pick.png', encodeGrayPng(sheet, W, H))
console.log('\ntmp/pick.png ← 選ばれた順に左から')
