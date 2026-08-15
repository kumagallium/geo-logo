/**
 * 左右の対を、正規化が動かしていないかを数える。
 *
 *   pnpm tsx scripts/pairs.ts tmp/targets tmp/gen
 *
 * 関係方式は対称を「構成で保証する」のが売りなので、後段で崩れていないかを
 * corpus 全体で見張る。対は id の末尾 M（figure.ts の鏡像展開）で見分ける。
 *
 * 「x=0 について対称か」では測れない。対は親を軸にした局所的な鏡像なので、
 * 横を向いた題材（カタツムリの目の柄）では親ごと軸から外れている。
 * 対の関係量（x の和・y の差）が正規化の前後で変わらないことを見る。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { designSchema } from '../src/core/dsl.js'
import { normalize } from '../src/core/normalize.js'
import { toDesign } from './plan.js'

const dirs = process.argv.slice(2)
if (dirs.length === 0) dirs.push('tmp/targets', 'tmp/gen')

for (const dir of dirs) {
  let pairs = 0
  let broken = 0
  let worst = 0
  let worstAt = ''
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let raw: ReturnType<typeof designSchema.parse>
    let out: ReturnType<typeof normalize>['design']
    try {
      raw = designSchema.parse(toDesign(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))))
      out = normalize(structuredClone(raw)).design
    } catch {
      continue
    }
    const span = Math.max(
      ...out.shapes.map((s) => ('cx' in s ? Math.abs(s.cx) + ('r' in s ? s.r : 0) : 0)),
      1,
    )
    // 対の関係量。鏡像なら x の和と y の差は親の位置だけで決まる
    const relation = (d: typeof out) => {
      const byId = new Map(d.shapes.map((s) => [s.id, s]))
      const map = new Map<string, [number, number]>()
      for (const s of d.shapes) {
        const m = byId.get(`${s.id}M`)
        if (!m || !('cx' in s) || !('cx' in m)) continue
        map.set(s.id, [s.cx + m.cx, s.cy - m.cy])
      }
      return map
    }
    const a = relation(raw)
    const b = relation(out)
    for (const [id, [sx, sy]] of a) {
      const after = b.get(id)
      if (!after) continue
      pairs++
      const err = Math.max(Math.abs(after[0] - sx), Math.abs(after[1] - sy)) / span
      if (err > 1e-6) broken++
      if (err > worst) {
        worst = err
        worstAt = `${f}:${id}`
      }
    }
  }
  console.log(
    `${dir.padEnd(12)} 対 ${String(pairs).padStart(3)} 組 / 崩れ ${String(broken).padStart(3)} 組` +
      ` / 最大ずれ ${(worst * 100).toFixed(4)}%${worstAt ? ` (${worstAt})` : ''}`,
  )
}
