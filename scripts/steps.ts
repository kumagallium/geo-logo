/**
 * steps を 1 つずつ増やしながら、どの演算で塊が壊れるかを見る。
 *
 *   pnpm tsx scripts/steps.ts plan.json
 *
 * ブーリアンの破綻は静かに起きる。塊が消えても次の add が新しい塊として
 * 積み直すので、完成形を見ても「何かが足りない」としか分からない。
 * 途中の枠とインクを並べれば、消えた瞬間が 1 行で分かる。
 */
import { readFileSync } from 'node:fs'
import { build } from '../src/core/index.js'
import { normalize } from '../src/core/normalize.js'
import { toDesign } from './plan.js'

const design = toDesign(JSON.parse(readFileSync(process.argv[2], 'utf8')))
const { design: norm } = normalize(design)
const steps = norm.parts[0].steps
for (let n = 1; n <= steps.length; n++) {
  const d = { ...norm, parts: [{ ...norm.parts[0], steps: steps.slice(0, n) }] }
  const b = build(d)
  const s = steps[n - 1]
  console.log(
    `${String(n).padStart(2)} ${s.op.padEnd(9)} ${s.ref.padEnd(10)} ` +
      `枠 ${b.artBounds.width.toFixed(2)}×${b.artBounds.height.toFixed(2)} インク ${(b.inkRatio * 100).toFixed(0)}%` +
      (b.warnings.length ? `  ⚠ ${b.warnings[0]}` : ''),
  )
}
