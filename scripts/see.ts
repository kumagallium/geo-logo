/**
 * 完成形を画像にして視覚モデルへ見せ、講評をもらう。
 *
 *   pnpm tsx scripts/see.ts tmp/xxx-design.json "ゴリラ"
 *
 * これまでモデルは一度も自分の描いたものを見ていなかった。デザイナーは
 * 引いては見て直すが、その輪が閉じていない。視覚モデルがあれば閉じられる。
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { rasterize } from '../src/core/raster.js'
import { fromEnv } from '../src/server/config/resolve-model.js'

const [file, subject = ''] = process.argv.slice(2)
const result = compile(JSON.parse(readFileSync(file, 'utf8')))
const png = rasterize(result.built, { size: 320 })
writeFileSync(file.replace(/\.json$/, '.png'), png)

const c = fromEnv()
if (!c?.apiKey || !c.apiBase) {
  console.error('.env から baseURL / key を解決できません')
  process.exit(1)
}
const model = process.env.GEOLOGO_VISION ?? 'preview/Qwen3-VL-30B-A3B-Instruct'

const res = await fetch(`${c.apiBase.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
  body: JSON.stringify({
    model,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `この白黒のマークを見てください。${subject ? `「${subject}」を表そうとしたものです。` : ''}\n` +
              '1) 何に見えますか（率直に）\n' +
              `2) ${subject ? `「${subject}」に見えるか` : '主題が読めるか'}を 10 点満点で\n` +
              '3) 直すとしたら、どの部分をどう動かしますか。1 つだけ挙げてください',
          },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      },
    ],
  }),
})

if (!res.ok) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 300))
  process.exit(1)
}
const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
console.log(`model: ${model}`)
console.log(body.choices?.[0]?.message?.content ?? '(応答なし)')
