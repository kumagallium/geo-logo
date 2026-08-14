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
import { buildFromArchetype } from '../src/core/archetypes.js'
import { buildFromComposition } from '../src/core/composition.js'
import { buildFromEmblem } from '../src/core/emblem.js'
import { buildFromFigure } from '../src/core/figure.js'
import { compile, type LogoDesign } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { buildFromOutline } from '../src/core/outline.js'
import { encodeGrayPng, rasterizeGray } from '../src/core/raster.js'
import { diagnose } from '../src/lib/design-agent.js'

export function toDesign(plan: Record<string, unknown>): LogoDesign {
  if (Array.isArray(plan.pieces)) return buildFromComposition(plan as never)
  if (Array.isArray(plan.contours)) return buildFromOutline(plan as never)
  if (Array.isArray(plan.nodes)) {
    // 節点方式は輪の並び（rings）を持つ。関係方式は持たない
    const first = plan.nodes[0] as Record<string, unknown> | undefined
    return first && Array.isArray(first.rings)
      ? buildFromEmblem(plan as never)
      : buildFromFigure(plan as never)
  }
  if (typeof plan.archetype === 'string') return buildFromArchetype(plan as never)
  return plan as unknown as LogoDesign
}

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
    cells.push(rasterizeGray(result.built, { size: CELL }).gray)
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
