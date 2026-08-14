/**
 * 参照する形から「きっかけの点」だけを取り出し、順方向に作図し直す。
 *
 *   pnpm tsx scripts/hint.ts reference.svg 出力名 [円の数]
 *
 * 輪郭はなぞらない。取り出すのは内接円の中心と半径だけで、そこから先は
 * 階梯へ寄せ、対称に畳んで作図する。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildFromComposition } from '../src/core/composition.js'
import { compile } from '../src/core/index.js'
import { packCircles } from '../src/core/pack.js'
import { fitToModule, mirrorAxis, sampleContoursFromSvg } from '../src/core/trace.js'
import { ladder } from '../src/core/emblem.js'

const [file, out = 'hint', n = '7'] = process.argv.slice(2)

const traced = sampleContoursFromSvg(readFileSync(file, 'utf8'))
const scaled = fitToModule(traced.map((t) => t.points))
const contours = scaled.map((points, i) => ({ points, solid: traced[i].solid }))

const circles = packCircles(contours, { count: Number(n) })
if (circles.length === 0) {
  console.error('円を取り出せませんでした')
  process.exit(1)
}

// ここから先が順方向の作図。
// 半径は階梯の段へ寄せ、対称軸があれば片側だけ残して反転させる。
const base = circles[0].r
// 参照が左右対称のときだけ、片側を捨てて反転で作る。
// 非対称な形（横向きの立ち姿など）に対称性を強制すると蝶のような形になる
const axis = mirrorAxis(scaled.flat())
const symmetric = axis !== null
const snapLadder = (r: number) => {
  const n = Math.round(Math.log(r / base) / Math.log(1.618))
  return ladder(base, 'golden', Math.max(-4, Math.min(2, n)))
}

const pieces = circles
  // 対称なら軸の片側だけ残し、残りは反転で作る
  .filter((c) => !symmetric || Math.abs(c.x - (axis as number)) < base * 0.12 || c.x >= (axis as number))
  .map((c) => {
    const x = symmetric ? c.x - (axis as number) : c.x
    return {
      label: '',
      form: 'disc' as const,
      role: 'add' as const,
      x: Math.round(x * 4) / 4,
      y: Math.round(c.y * 4) / 4,
      size: snapLadder(c.r),
      mirror: symmetric && Math.abs(x) >= base * 0.12,
    }
  })

const design = buildFromComposition({
  name: out,
  concept: `参照した形から内接円 ${circles.length} 個を取り出し、半径を黄金比の階梯へ寄せて対称に作図した`,
  ratio: 'golden',
  pieces,
} as never)

const result = compile(design)
mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)
writeFileSync(`tmp/${out}-poster.svg`, result.posterSvg)

const radii = [...new Set(design.shapes.map((s) => ('r' in s ? Math.round(s.r * 1000) : 0)))]
console.log(
  `${out}: 取り出した円 ${circles.length} → 部品 ${pieces.length}（反転後 ${design.shapes.length}）/ ` +
    `異なる半径 ${radii.length} 種 / 対称 ${symmetric ? 'あり' : 'なし'} / インク ${(result.built.inkRatio * 100).toFixed(0)}%`,
)
