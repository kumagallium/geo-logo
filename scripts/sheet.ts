/**
 * 案をまとめて 1 枚に焼き、同時に計測する。
 *
 *   pnpm tsx scripts/sheet.ts tmp/sheet.png a.json b.json ...
 *
 * 1 案ずつ SVG を書き出して個別に開いていると、案どうしの差が見えない。
 * 「どれが良いか」は並べないと決まらないので、並べる道具を先に作る。
 * JSON の種類（design / composition / outline / emblem / archetype）は
 * 鍵の有無で見分けるので、呼ぶ側は気にしなくてよい。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { compile } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { encodeGrayPng } from '../src/core/png.js'
import { rasterizeGray } from '../src/core/raster.js'
import { diagnose } from '../src/lib/design-agent.js'
import { toDesign } from './plan.js'

const [out = 'tmp/sheet.png', ...files] = process.argv.slice(2)
if (files.length === 0) {
  console.error('使い方: pnpm tsx scripts/sheet.ts out.png plan1.json plan2.json ...')
  process.exit(1)
}

const CELL = 240
const GAP = 6

const cells: Uint8Array[] = []
for (const file of files) {
  const name = file.split('/').pop()?.replace(/\.json$/, '') ?? file
  try {
    const result = compile(toDesign(JSON.parse(readFileSync(file, 'utf8'))))
    cells.push(rasterizeGray(result.built, { size: CELL, samples: 3 }).gray)
    const problems = diagnose(result)
    console.log(`${name.padEnd(16)} ${formatMetrics(measure(result.design, result.built))}`)
    for (const p of problems) console.log(`${' '.repeat(17)}⚠ ${p.split('\n')[0]}`)
  } catch (e) {
    // 1 件の失敗でシート全体を落とさない。空の枠を置いて先へ進む
    cells.push(new Uint8Array(CELL * CELL).fill(230))
    console.log(`${name.padEnd(16)} ✗ ${e instanceof Error ? e.message.split('\n')[0] : e}`)
  }
}

const cols = Math.ceil(Math.sqrt(cells.length))
const rows = Math.ceil(cells.length / cols)
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

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, encodeGrayPng(sheet, W, H))
console.log(`\n${out} ← ${cells.length} 件（${cols} 列・左上から右へ）`)
