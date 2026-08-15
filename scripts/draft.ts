/**
 * ラフを直すための下描き用紙。
 *
 *   pnpm tsx scripts/draft.ts tmp/ref/jackal-out.json jackal
 *
 * 完成したシルエットだけを見ていると、**どの点が悪いのか分からない**。
 * 直すたびに勘で座標を動かすことになる。番号を振った点・補間した曲線・
 * 当てはめた円弧・完成形を重ねて出す。人が下描きを直すときに見ているもの。
 *
 * 出力は SVG 1 枚（tmp/<名前>-draft.svg）。ラスタライザを増やさないので、
 * ブラウザでもエディタでもそのまま開ける。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../src/core/index.js'
import { formatMetrics, measure } from '../src/core/metrics.js'
import { buildFromOutline, outlineStages, type OutlinePlan } from '../src/core/outline.js'

const [file, out = 'draft'] = process.argv.slice(2)
if (!file) {
  console.error('使い方: pnpm tsx scripts/draft.ts plan.json 出力名')
  process.exit(1)
}
const plan = JSON.parse(readFileSync(file, 'utf8')) as OutlinePlan
const stages = outlineStages(plan)
const result = compile(buildFromOutline(plan))

// 紙面。左が下描き（点と曲線）、右が完成形
const PANEL = 420
const PAD = 24
const W = PANEL * 2 + PAD * 3
const H = PANEL + PAD * 2 + 34

// モジュール座標 → 紙面座標。両パネルで同じ倍率を使う
const all = stages.flatMap((s) => s.points)
const span = Math.max(
  ...all.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))),
  1,
) * 2.3
const scale = PANEL / span
const at = (panel: number, p: { x: number; y: number }) => ({
  x: PAD + panel * (PANEL + PAD) + PANEL / 2 + p.x * scale,
  y: PAD + 34 + PANEL / 2 + p.y * scale,
})

const e: string[] = []
const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)

e.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`)
e.push(`<rect width="${W}" height="${H}" fill="#faf8f4"/>`)
e.push(
  `<text x="${PAD}" y="24" font-family="sans-serif" font-size="15" fill="#333">下描き（番号が点の順）</text>`,
)
e.push(
  `<text x="${PAD * 2 + PANEL}" y="24" font-family="sans-serif" font-size="15" fill="#333">完成形</text>`,
)

// 左: 完成形を薄く敷き、その上にラフの点と当てはめた円弧を重ねる
for (const panel of [0, 1]) {
  const o = at(panel, { x: 0, y: 0 })
  const k = scale / (result.design.module || 64)
  e.push(
    `<g transform="translate(${o.x} ${o.y}) scale(${k})">` +
      result.built.parts
        .map(
          (p) =>
            `<path d="${p.pathData}" fill="${panel === 0 ? '#d8d2c8' : '#1a1a1a'}" fill-rule="evenodd"/>`,
        )
        .join('') +
      `</g>`,
  )
}

// 軸。点の座標を読むときの手がかり
const c0 = at(0, { x: 0, y: 0 })
e.push(
  `<path d="M ${c0.x - PANEL / 2} ${c0.y} H ${c0.x + PANEL / 2} M ${c0.x} ${c0.y - PANEL / 2} V ${c0.y + PANEL / 2}" stroke="#c9c2b6" stroke-width="1" fill="none"/>`,
)

const HUE = ['#c2410c', '#1d4ed8', '#15803d', '#7c3aed', '#b45309', '#0f766e', '#be123c', '#4d7c0f']

stages.forEach((s, si) => {
  const color = HUE[si % HUE.length]
  // 補間した曲線。点と点の間がどう繋がったかが見える
  const dense = s.dense.map((p, i) => `${i === 0 ? 'M' : 'L'} ${at(0, p).x.toFixed(1)} ${at(0, p).y.toFixed(1)}`)
  e.push(`<path d="${dense.join(' ')} Z" stroke="${color}" stroke-width="1.4" fill="none" opacity="0.75"/>`)

  // 当てはめた円弧の継ぎ目。ここが「作図の節」になる
  for (const seg of s.segments) {
    const q = at(0, seg)
    e.push(`<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="4" fill="none" stroke="${color}" stroke-width="1.6"/>`)
  }

  // ラフの点。番号が JSON の並び順
  s.points.forEach((p, i) => {
    const q = at(0, p)
    e.push(`<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="2.6" fill="${color}"/>`)
    e.push(
      `<text x="${(q.x + 5).toFixed(1)}" y="${(q.y - 4).toFixed(1)}" font-family="monospace" font-size="10" fill="${color}">${i}</text>`,
    )
  })
})

const legend = stages
  .map((s, i) => `${esc(s.label)}: 点 ${s.points.length} → 弧 ${s.segments.length}${s.role === 'hole' ? '（抜き）' : ''}`)
  .join(' / ')
e.push(
  `<text x="${PAD}" y="${H - 6}" font-family="sans-serif" font-size="12" fill="#666">${esc(legend)}</text>`,
)
e.push('</svg>')

mkdirSync('tmp', { recursive: true })
writeFileSync(`tmp/${out}-draft.svg`, e.join('\n'))
writeFileSync(`tmp/${out}-logo.svg`, result.logoSvg)

console.log(formatMetrics(measure(result.design, result.built)))
console.log(legend)
console.log(`tmp/${out}-draft.svg`)
