import type { Vec } from './trace'
import { getPaper, resetProject } from './paper-setup'

/**
 * 参照する形から「円が自然に収まる位置」だけを取り出す。
 *
 * 輪郭をなぞるのとは違う。取り出すのは少数の円（中心と半径）だけで、
 * 線の 1 本 1 本は持ち帰らない。設計としてはそこから先——どの円を採るか、
 * 階梯のどの段へ寄せるか、対称にどう畳むか——を順方向に作図する。
 *
 * ずっと空席だったのは配置の判断だった。モデルにも私にも「ゴリラを円で
 * どう置くか」は分からなかった。参照物はそこだけを埋める。形を写すのでは
 * なく、きっかけを渡す。
 *
 * 手順は内接円の貪欲詰め込み。距離変換で「境界から最も遠い点」を探し、
 * そこに円を置き、その円を消してまた探す。大きい順に出るので、上位 n 個を
 * 採れば自然に要約になる。
 */

export type PackedCircle = { x: number; y: number; r: number }

export type PackOptions = {
  /** 取り出す円の数 */
  count?: number
  /** 距離変換の格子の細かさ（一辺の画素数） */
  resolution?: number
  /** 最も大きい円に対して、これより小さい円は採らない */
  minRatio?: number
}

/**
 * 2 パスのチャンファー距離変換。
 *
 * 厳密なユークリッド距離ではないが、円を置く位置を決めるには十分で、
 * 総当たり（内側の各点から全境界点までの距離）より桁違いに速い。
 */
function distanceTransform(inside: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h)
  const FAR = 1e9
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? FAR : 0

  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x])
  const D1 = 1
  const D2 = Math.SQRT2

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside[y * w + x]) continue
      d[y * w + x] = Math.min(
        d[y * w + x],
        at(x - 1, y) + D1,
        at(x, y - 1) + D1,
        at(x - 1, y - 1) + D2,
        at(x + 1, y - 1) + D2,
      )
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      if (!inside[y * w + x]) continue
      d[y * w + x] = Math.min(
        d[y * w + x],
        at(x + 1, y) + D1,
        at(x, y + 1) + D1,
        at(x + 1, y + 1) + D2,
        at(x - 1, y + 1) + D2,
      )
    }
  }
  return d
}

/**
 * 閉じた輪郭の集合から内接円を大きい順に取り出す。
 *
 * contours の先頭を実体、solid が false のものを抜きとして扱う。
 */
export function packCircles(
  contours: Array<{ points: Vec[]; solid: boolean }>,
  options: PackOptions = {},
): PackedCircle[] {
  const count = Math.max(1, Math.min(options.count ?? 8, 32))
  const res = Math.max(48, Math.min(options.resolution ?? 220, 512))
  const minRatio = options.minRatio ?? 0.16

  const all = contours.flatMap((c) => c.points)
  if (all.length === 0) return []

  const xs = all.map((p) => p.x)
  const ys = all.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const span = Math.max(maxX - minX, maxY - minY)
  if (span <= 0) return []

  // 端の円が枠で切れないよう、少し外側まで格子を張る
  const pad = span * 0.06
  const x0 = (minX + maxX) / 2 - span / 2 - pad
  const y0 = (minY + maxY) / 2 - span / 2 - pad
  const step = (span + pad * 2) / res

  const p = getPaper()
  resetProject()
  const inside = new Uint8Array(res * res)
  try {
    let shape: paper.PathItem | null = null
    for (const c of contours) {
      const path = new p.Path(c.points.map((q) => new p.Point(q.x, q.y)))
      path.closed = true
      if (!shape) {
        if (!c.solid) {
          path.remove()
          continue
        }
        shape = path
        continue
      }
      const next: paper.PathItem = c.solid ? shape.unite(path) : shape.subtract(path)
      shape.remove()
      path.remove()
      shape = next
    }
    if (!shape) return []

    for (let gy = 0; gy < res; gy++) {
      for (let gx = 0; gx < res; gx++) {
        const pt = new p.Point(x0 + (gx + 0.5) * step, y0 + (gy + 0.5) * step)
        if (shape.contains(pt)) inside[gy * res + gx] = 1
      }
    }
    shape.remove()
  } finally {
    resetProject()
  }

  const dist = distanceTransform(inside, res, res)
  const out: PackedCircle[] = []

  for (let n = 0; n < count; n++) {
    let best = -1
    let bestIdx = -1
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] > best) {
        best = dist[i]
        bestIdx = i
      }
    }
    if (bestIdx < 0 || best <= 0) break

    const gx = bestIdx % res
    const gy = Math.floor(bestIdx / res)
    const r = best * step
    if (out.length > 0 && r < out[0].r * minRatio) break

    out.push({ x: x0 + (gx + 0.5) * step, y: y0 + (gy + 0.5) * step, r })

    // 採った円を消して次を探す。少し広めに消さないと同じ場所が何度も出る
    const cut = Math.ceil(best * 1.05)
    for (let dy = -cut; dy <= cut; dy++) {
      const yy = gy + dy
      if (yy < 0 || yy >= res) continue
      for (let dx = -cut; dx <= cut; dx++) {
        const xx = gx + dx
        if (xx < 0 || xx >= res) continue
        if (dx * dx + dy * dy <= cut * cut) dist[yy * res + xx] = 0
      }
    }
  }

  return out
}
