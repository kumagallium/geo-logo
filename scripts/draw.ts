/**
 * 絵を作らせてから作図を起こす。画像先行の経路をひと息で通す。
 *
 *   pnpm tsx scripts/draw.ts "ゴリラのように強いガラスを作る会社のロゴ" gorilla
 *
 * 順方向（モデルに幾何を書かせる）で届かない構図を出すための経路。
 * 途中の絵も残すので、「絵が悪いのか、復元が悪いのか」を切り分けられる。
 */
import { config as loadEnv } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { decodeGray } from '../src/core/png.js'
import { encodeGrayPng } from '../src/core/png.js'
import { rasterizeGray } from '../src/core/raster.js'
import { alignedFidelity, reconstruct } from '../src/core/reconstruct.js'
import { explainImageError, generateSymbolImage, imageConfigFromEnv } from '../src/lib/image-agent.js'

loadEnv()

const [brief, out = 'draw', tolArg] = process.argv.slice(2)
if (!brief) {
  console.error('使い方: pnpm tsx scripts/draw.ts "ブリーフ" 出力名 [許容誤差]')
  console.error('環境変数:')
  console.error('  GOOGLE_GENERATIVE_AI_API_KEY  Google AI Studio（1 日 500 枚まで無償）')
  console.error('  OPENAI_API_KEY                OpenAI（従量課金）')
  console.error('  どちらでもない宛先は GEOLOGO_IMAGE_PROVIDER / _MODEL / _API_KEY で指定')
  process.exit(1)
}

const imageConfig = imageConfigFromEnv(process.env)
if (!imageConfig) {
  console.error('画像モデルの鍵がありません。GOOGLE_GENERATIVE_AI_API_KEY か OPENAI_API_KEY を .env へ')
  process.exit(1)
}

const tolerance = tolArg ? Number(tolArg) : 0.012
mkdirSync('tmp', { recursive: true })

console.log(`絵を作っています（${imageConfig.provider} / ${imageConfig.modelId}）... 1 回の実行で 1 枚だけ作ります`)
let png: Uint8Array
try {
  png = (await generateSymbolImage(brief, imageConfig)).png
} catch (error) {
  console.error(explainImageError(error))
  process.exit(1)
}
writeFileSync(`tmp/${out}-image.png`, png)

const image = decodeGray(Buffer.from(png))
if (image.width !== image.height) {
  console.error(`正方形で返りませんでした（${image.width}x${image.height}）`)
  process.exit(1)
}

console.log('作図に起こしています...')
const design = reconstruct(image.gray, image.width, image.height, {
  tolerance,
  // 当てはめたままの半径は 20〜30 種になり、「作図」ではなく「なめらかにした
  // トレース」に見える。8 種へ畳んでも見た目は変わらない（実測: 歩くゴリラで
  // 25 → 8 種、視覚的な差なし）。家紋の実測は 3〜5 種
  radii: 8,
  name: brief.slice(0, 40),
  concept: brief,
})
const result = compile(design)
const back = rasterizeGray(result.built, { size: image.width, samples: 1 })

writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)
writeFileSync(`tmp/${out}-blueprint.svg`, result.blueprintSvg)
writeFileSync(`tmp/${out}-plan.json`, JSON.stringify(design, null, 1))
writeFileSync(`tmp/${out}-mask.png`, encodeGrayPng(image.gray, image.width, image.height))

console.log(formatMetrics(measure(result.design, result.built)))
console.log(`絵との一致 ${(alignedFidelity(image.gray, image.width, image.height, back.gray, back.size, back.size) * 100).toFixed(1)}%（墨を揃えて比較）`)
console.log(`tmp/${out}-image.png / -logo.svg / -blueprint.svg / -plan.json`)
