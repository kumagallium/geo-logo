/**
 * 設定済みプロバイダーで実際に 1 件生成し、パイプライン全体を通す煙試験。
 *
 *   pnpm smoke "山と川を円弧で表した、地質調査会社のマーク"
 *
 * .env の GEOLOGO_* を読む。API キーは環境変数から渡るだけで、
 * このスクリプトは値を表示しない（長さのみ出す）。
 *
 * 出力される SVG は tmp/ 配下（.gitignore 済み）。
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { createModel } from '../src/lib/create-model.js'
import { designLogo } from '../src/lib/design-agent.js'
import { fromEnv } from '../src/server/config/resolve-model.js'

const brief = process.argv.slice(2).join(' ') || '山と川を円弧で表した、地質調査会社のマーク'

const config = fromEnv()
if (!config) {
  console.error(
    '環境変数からモデルを解決できませんでした。.env に GEOLOGO_PROVIDER / GEOLOGO_BASE_URL / GEOLOGO_API_KEY / GEOLOGO_MODEL を設定してください。',
  )
  process.exit(1)
}

if (!config.apiKey || config.apiKey === 'PASTE_YOUR_KEY_HERE') {
  console.error('.env の GEOLOGO_API_KEY がまだプレースホルダのままです。実際のキーに置き換えてください。')
  process.exit(1)
}
// 非 ASCII が混ざったキーは HTTP ヘッダーに載らず、意味の分かりにくい
// ByteString エラーになる。ここで先に弾く。
if (/[^\x20-\x7e]/.test(config.apiKey)) {
  console.error('GEOLOGO_API_KEY に ASCII 以外の文字が含まれています。貼り付けを確認してください。')
  process.exit(1)
}

console.log('provider :', config.provider)
console.log('model    :', config.modelId)
console.log('baseURL  :', config.apiBase ?? '(既定)')
console.log('apiKey   :', config.apiKey ? `設定あり（${config.apiKey.length} 文字）` : '未設定')
console.log('brief    :', brief)
console.log('---')

const started = Date.now()
try {
  const outcome = await designLogo(brief, createModel(config))
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  console.log(`生成: ${outcome.attempts.length} 回の試行 / ${elapsed}s`)
  outcome.attempts.forEach((a, i) => {
    console.log(
      `  試行 ${i + 1}: ${a.problems.length === 0 ? 'OK' : `${a.problems.length} 件の問題`}`,
    )
    for (const p of a.problems) console.log(`    - ${p.replace(/\n/g, '\n      ')}`)
  })

  const { design, built, notes, warnings, constraintErrors, logoSvg, blueprintSvg } =
    compile(outcome.result.design)

  console.log('---')
  console.log('name       :', design.name)
  console.log('concept    :', design.concept)
  console.log(
    `構成       : shapes ${design.shapes.length} / constraints ${design.constraints.length} / groups ${design.groups.length} / parts ${design.parts.length}`,
  )
  console.log(`正規化     : スナップ ${notes.filter((n) => n.reason === 'snap').length} 件 / 制約移動 ${notes.filter((n) => n.reason === 'constraint').length} 件`)
  console.log('warnings   :', warnings.length === 0 ? 'なし' : warnings.join(' / '))
  console.log('未解決制約 :', constraintErrors.length === 0 ? 'なし' : constraintErrors.join(' / '))
  console.log(
    `完成形     : ${built.artBounds.width.toFixed(0)} x ${built.artBounds.height.toFixed(0)} px`,
  )

  mkdirSync('tmp', { recursive: true })
  writeFileSync('tmp/smoke-logo.svg', logoSvg)
  writeFileSync('tmp/smoke-blueprint.svg', blueprintSvg)
  writeFileSync('tmp/smoke-design.json', JSON.stringify(design, null, 2))
  console.log('---')
  console.log('出力: tmp/smoke-logo.svg, tmp/smoke-blueprint.svg, tmp/smoke-design.json')
} catch (err) {
  console.error('---')
  console.error('失敗:', err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  const code = (err as { code?: string })?.code
  if (code) console.error('code:', code)
  process.exit(1)
}
