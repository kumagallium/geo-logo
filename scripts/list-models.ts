/**
 * 設定中のエンドポイントで使えるモデルを一覧する。
 *   pnpm tsx scripts/list-models.ts
 */
import 'dotenv/config'
import { fromEnv } from '../src/server/config/resolve-model.js'

const c = fromEnv()
if (!c?.apiKey || !c.apiBase) {
  console.error('.env から baseURL / key を解決できません')
  process.exit(1)
}
const url = `${c.apiBase.replace(/\/+$/, '')}/models`
console.log('問い合わせ先:', url)
const res = await fetch(url, { headers: { authorization: `Bearer ${c.apiKey}` } })
console.log('HTTP', res.status)
const body = await res.text()
try {
  const d = JSON.parse(body) as { data?: Array<{ id?: string; owned_by?: string }> }
  for (const m of d.data ?? []) console.log(' -', m.id, m.owned_by ? `(${m.owned_by})` : '')
} catch {
  console.log(body.slice(0, 400))
}
