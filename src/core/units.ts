/**
 * モジュール系の「きれいな値」テーブル。
 *
 * 正規化はここで作った候補集合への最近傍スナップとして実装する。
 * 「幾何学的に正しく見える」感覚は、寸法が単一のモジュール M から
 * 導かれた少数の値だけで構成されていることに由来する。
 */

export const PHI = (1 + Math.sqrt(5)) / 2

export type Candidate = { value: number; label: string }

const FIB = [1, 2, 3, 5, 8, 13, 21, 34]

function phiPowers(): Candidate[] {
  const out: Candidate[] = []
  for (let n = -4; n <= 5; n++) {
    const v = Math.pow(PHI, n)
    if (v < 0.05 || v > 40) continue
    const label = n === 0 ? '1' : n === 1 ? 'φ' : `φ^${n}`
    out.push({ value: v, label })
  }
  return out
}

function halfSteps(): Candidate[] {
  const out: Candidate[] = []
  for (let k = 1; k <= 64; k++) {
    const v = k / 2
    out.push({ value: v, label: v % 1 === 0 ? `${v}M` : `${v}M` })
  }
  return out
}

function fibRatios(): Candidate[] {
  const out: Candidate[] = []
  for (const a of FIB) {
    for (const b of FIB) {
      if (a >= b) continue
      const v = a / b
      if (v < 0.08) continue
      out.push({ value: v, label: `${a}/${b}` })
    }
  }
  return out
}

let cachedRadius: Candidate[] | null = null

/** 半径・太さ用の候補（φ 冪 → フィボナッチ比 → 1/2 刻み の優先順） */
export function radiusCandidates(): Candidate[] {
  if (cachedRadius) return cachedRadius
  const merged = [...phiPowers(), ...fibRatios(), ...halfSteps()]
  const seen = new Map<string, Candidate>()
  for (const c of merged) {
    const key = c.value.toFixed(4)
    if (!seen.has(key)) seen.set(key, c)
  }
  cachedRadius = [...seen.values()].sort((a, b) => a.value - b.value)
  return cachedRadius
}

let cachedCoord: Candidate[] | null = null

/** 座標用の候補（グリッド交点＋φ 系の位置） */
export function coordCandidates(): Candidate[] {
  if (cachedCoord) return cachedCoord
  const out: Candidate[] = []
  for (let k = -64; k <= 64; k++) {
    const v = k / 2
    out.push({ value: v, label: `${v}M` })
  }
  for (let n = -3; n <= 4; n++) {
    const v = Math.pow(PHI, n)
    if (v > 32) continue
    out.push({ value: v, label: n === 1 ? 'φ' : `φ^${n}` })
    out.push({ value: -v, label: n === 1 ? '-φ' : `-φ^${n}` })
  }
  const seen = new Map<string, Candidate>()
  for (const c of out) {
    const key = c.value.toFixed(4)
    if (!seen.has(key)) seen.set(key, c)
  }
  cachedCoord = [...seen.values()].sort((a, b) => a.value - b.value)
  return cachedCoord
}

/**
 * 候補集合への最近傍スナップ。
 * `tol` は相対許容差。これを超えて離れている場合は「意図された値」とみなし、そのまま返す。
 */
export function snap(
  value: number,
  candidates: Candidate[],
  tol: number,
): { value: number; label: string | null; changed: boolean } {
  const scale = Math.max(Math.abs(value), 0.5)
  let best: Candidate | null = null
  let bestDist = Infinity
  for (const c of candidates) {
    const d = Math.abs(c.value - value)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  if (!best || bestDist / scale > tol) {
    return { value, label: null, changed: false }
  }
  const changed = Math.abs(best.value - value) > 1e-9
  return { value: best.value, label: best.label, changed }
}

/** グリッド線を引くための刻み幅（モジュール単位） */
export function gridStep(grid: 'golden' | 'sqrt2' | 'square' | 'isometric'): number {
  switch (grid) {
    case 'golden':
      return 1
    case 'sqrt2':
      return Math.SQRT2 / 2
    case 'square':
      return 0.5
    case 'isometric':
      return 1
  }
}
