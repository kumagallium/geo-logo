/**
 * 画素から作図を復元する。
 *
 *   pnpm tsx scripts/reconstruct.ts 画像.png 出力名 [許容誤差]
 *   pnpm tsx scripts/reconstruct.ts samples/c-sakura.json 出力名   # 往復検査
 *
 * 順方向（モデルに幾何を書かせる）で届かない構図を、絵から起こすための入口。
 * JSON を渡すと、一度焼いてから復元し直すので、復元そのものの精度が測れる。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { alignedFidelity, reconstruct } from '../src/core/reconstruct.js'
import { encodeGrayPng } from '../src/core/png.js'
import { rasterizeGray } from '../src/core/raster.js'
import { decodeGray } from '../src/core/png.js'
import { toDesign } from './plan.js'

const [file, out = "recon", tolArg] = process.argv.slice(2)
if (!file || !existsSync(file)) {
  console.error('使い方: pnpm tsx scripts/reconstruct.ts 画像.png|計画.json 出力名 [許容誤差]')
  process.exit(1)
}
const tolerance = tolArg ? Number(tolArg) : 0.02

const SIZE = 512
let gray: Uint8Array
let width = SIZE
let height = SIZE
if (file.endsWith('.json')) {
  const built = compile(toDesign(JSON.parse(readFileSync(file, 'utf8'))))
  const r = rasterizeGray(built.built, { size: SIZE, samples: 3 })
  gray = r.gray
  width = r.size
  height = r.size
} else {
  const img = decodeGray(readFileSync(file))
  gray = img.gray
  width = img.width
  height = img.height
  console.log(`${width}x${height} を読みました`)
}

const design = reconstruct(gray, width, height, { tolerance, radii: 8, name: out })
const result = compile(design)
// 焼き直しは正方形。rasterizeGray は 1024 が上限なので、返ってきた寸法を使う
const back = rasterizeGray(result.built, { size: Math.max(width, height), samples: 1 })
const side = back.size

mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)
writeFileSync(`tmp/${out}-src.png`, encodeGrayPng(gray, width, height))

console.log(formatMetrics(measure(result.design, result.built)))
// 墨の外接矩形どうしを揃えて比べる。元の絵の余白や位置に左右されない
console.log(`一致 ${(alignedFidelity(gray, width, height, back.gray, side, side) * 100).toFixed(1)}%（墨を揃えて比較）`)
console.log(`tmp/${out}-logo.svg / -blueprint.svg`)
