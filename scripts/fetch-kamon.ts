/**
 * Wikimedia Commons から家紋の SVG を集める。
 *
 *   pnpm tsx scripts/fetch-kamon.ts [目標件数]
 *
 * 集めた家紋はトレースして「定石」を測るためだけに使う（scripts/kamon-ratios.ts）。
 * 成果は係数の表として順方向の作図へ戻すので、成果物に他人の図形は入らない。
 *
 * 既定はパブリックドメインと CC0 だけ。判定は Commons が返すメタデータで
 * 行い、判定できないものは落とす。
 *
 * KAMON_MEASURE_ONLY=1 を付けると CC BY-SA も対象にする。紋の意匠自体は
 * 数百年前のもので自由だが、SVG に起こした人の権利が乗っているため、
 * 自由なファイルは全体の 8% しかない。母数が足りないと係数が定まらない。
 *
 * 測定専用の取得なので、集めた図形は data/（gitignore 済み）から出ない。
 * 再配布せず、成果物にも入らない。外へ出るのは数値の表だけ。
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const API = 'https://commons.wikimedia.org/w/api.php'
const UA = 'geo-logo-research/0.1 (geometric logo research; https://github.com/kumagallium)'
const OUT = 'data/kamon'
const TARGET = Number(process.argv[2] ?? 50)

/** 家紋の SVG を探すための検索語。表記が揺れるので複数から集める。 */
const QUERIES = [
  'intitle:"Japanese Crest" filemime:image/svg+xml',
  'intitle:Kamon filemime:image/svg+xml',
  'intitle:"Japanese crest" filemime:image/svg+xml',
  'intitle:Mon japanese crest filemime:image/svg+xml',
]

/** 測定専用モードでは CC BY-SA まで受け入れる。 */
const MEASURE_ONLY = process.env.KAMON_MEASURE_ONLY === '1'

/** パブリックドメインと CC0 だけ。判定できないものは落とす。 */
function isFree(license: string, usage: string): boolean {
  const k = `${license} ${usage}`.toLowerCase()
  if (MEASURE_ONLY && (k.includes('cc by') || k.includes('creative commons'))) return true
  if (k.includes('cc0') || k.includes('public domain') || k.includes('pd-')) return true
  // 「PD」を含むだけの表記（PD-self, PD-Japan-organization など）も許す
  return /\bpd\b/.test(k)
}

async function api(params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json' })}`
  // Commons は連投すると 429 を返す。待って直す（弾かれたまま進むと
  // 「該当なし」に見えて、母数が足りない結論を出してしまう）
  for (let t = 0; t < 5; t++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) return (await res.json()) as Record<string, unknown>
    if (res.status !== 429) throw new Error(`${res.status} ${url}`)
    await new Promise((r) => setTimeout(r, 4000 * (t + 1)))
  }
  throw new Error(`429 が続きました: ${url}`)
}

type Found = { title: string; url: string; license: string }

async function search(query: string, limit: number): Promise<string[]> {
  const out: string[] = []
  let offset = 0
  while (out.length < limit) {
    const d = (await api({
      action: 'query',
      list: 'search',
      srsearch: query,
      srnamespace: '6',
      srlimit: '50',
      sroffset: String(offset),
    })) as { query?: { search?: Array<{ title: string }> }; continue?: { sroffset: number } }
    const hits = d.query?.search ?? []
    if (hits.length === 0) break
    out.push(...hits.map((h) => h.title))
    if (!d.continue) break
    offset = d.continue.sroffset
  }
  return out.slice(0, limit)
}

async function details(titles: string[]): Promise<Found[]> {
  const out: Found[] = []
  // titles は 50 件ずつ。まとめて投げないと呼び出し回数が跳ね上がる
  for (let i = 0; i < titles.length; i += 50) {
    const d = (await api({
      action: 'query',
      titles: titles.slice(i, i + 50).join('|'),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
    })) as {
      query?: {
        pages?: Record<
          string,
          {
            title: string
            imageinfo?: Array<{
              url: string
              mime?: string
              extmetadata?: Record<string, { value?: string }>
            }>
          }
        >
      }
    }
    for (const page of Object.values(d.query?.pages ?? {})) {
      const info = page.imageinfo?.[0]
      // Commons の URL は .svg の後にクエリが付くことがある。末尾一致で
      // 判定すると全件落ちて「該当なし」に見える（実際に 0 件になった）
      if (!info || !/\.svg(\?|$)/i.test(info.url)) continue
      const em = info.extmetadata ?? {}
      const license = em.LicenseShortName?.value ?? em.License?.value ?? ''
      const usage = em.UsageTerms?.value ?? ''
      if (!isFree(license, usage)) continue
      out.push({ title: page.title, url: info.url, license })
    }
  }
  return out
}

const seen = new Set<string>()
const picked: Found[] = []
for (const q of QUERIES) {
  if (picked.length >= TARGET) break
  // 上限を切りすぎると、自由なファイルが後ろのページに埋もれて 0 件に見える
  const titles = (await search(q, 400)).filter((t) => !seen.has(t))
  for (const t of titles) seen.add(t)
  const free = await details(titles)
  for (const f of free) {
    if (picked.length >= TARGET) break
    picked.push(f)
  }
  console.log(`${q}: 候補 ${titles.length} → 自由 ${free.length}（累計 ${picked.length}）`)
}

mkdirSync(OUT, { recursive: true })
const manifest: Array<{ file: string; title: string; license: string; url: string }> = []
let n = 0
for (const f of picked) {
  // クエリを落として原本を取る。付けたままだと弾かれるものがある
  const src = f.url.replace(/\?.*$/, '')
  let svg = ''
  for (let t = 0; t < 4; t++) {
    const res = await fetch(src, { headers: { 'User-Agent': UA } })
    if (res.ok) {
      svg = await res.text()
      break
    }
    // 連投すると 429 が返る。待たずに諦めると母数が静かに減る
    if (res.status !== 429) break
    await new Promise((r) => setTimeout(r, 3000 * (t + 1)))
  }
  if (!svg) continue
  // 中身が SVG でないものは落とす（リダイレクト先が HTML のことがある）
  if (!/<svg[\s>]/i.test(svg)) continue
  const file = `k${String(++n).padStart(3, '0')}.svg`
  writeFileSync(`${OUT}/${file}`, svg)
  manifest.push({ file, title: f.title, license: f.license, url: f.url })
}

// 出どころを残す。どの図形からどの係数を導いたかを後から追えるようにする
writeFileSync(
  `${OUT}/manifest.json`,
  `${JSON.stringify({ measureOnly: MEASURE_ONLY, files: manifest }, null, 2)}\n`,
)
console.log(`\n${manifest.length} 点を ${OUT}/ へ保存しました`)
const byLicense = new Map<string, number>()
for (const m of manifest) byLicense.set(m.license, (byLicense.get(m.license) ?? 0) + 1)
for (const [k, v] of [...byLicense].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
