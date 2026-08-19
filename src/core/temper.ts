import type { Contour, LogoDesign } from './dsl'
import { PHI } from './units'

/**
 * 計測（temper）——絵から起こした輪郭が、どれだけ規則に近いかを測る。
 *
 * かつてここは「ほぼ円なら円にする」「ほぼ φ ならその比にする」と**形を寄せて**
 * いた。だが素直なベクタ化（potrace）と比べる検証で、その路線は割に合わないと
 * 分かった: 幾何的な題材では一致率で 1.7〜3.4%、筆致では 25% を失い、しかも
 * 有機的な題材では寄せ先そのものが見つからない（ゴリラは 6〜8 図形のうち円に
 * できたものが 0 件）。復元は元の絵を超えられない。
 *
 * そこで役割を裏返した。**絵は動かさず、測って言う**。
 *
 *   - この輪郭は真円から 4.8% ずれている
 *   - 全体の縦横比は 1.32 : 1（φ ではない）
 *   - 墨の重心は外接矩形の中心から 0.24M ずれている
 *   - 半径は 8 種類あり、うち 5 種はモジュール系の値に近い
 *
 * 主張ではなく事実なので、飾りにならない。設計図はこの計測の上に乗る。
 * 「ほぼ○○だから○○ということにする」を一度でもやると、設計図は嘘をつく。
 */

/** normalize と同じ記録口。計測は reason: 'measure' で入る */
export type Recorder = (
  shapeId: string,
  field: string,
  from: number,
  to: number,
  label: string | null,
  reason: 'snap' | 'constraint' | 'measure',
) => void

/** 縦横比として名前を持つ比 */
const CANONICAL_RATIOS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1:1' },
  { value: PHI, label: '1:φ' },
  { value: 1 / PHI, label: 'φ:1' },
  { value: Math.SQRT2, label: '1:√2' },
  { value: 1 / Math.SQRT2, label: '√2:1' },
  { value: 3 / 2, label: '2:3' },
  { value: 2 / 3, label: '3:2' },
  { value: 2, label: '1:2' },
  { value: 0.5, label: '2:1' },
]

/** 名前を付けてよい近さ。これを超えたら「その比ではない」 */
const RATIO_NAME_TOL = 0.03

type Seg = Contour['segments'][number]

function contoursOf(design: LogoDesign): Contour[] {
  return design.shapes.filter((s): s is Contour => s.kind === 'contour')
}

const round = (v: number) => Math.round(v * 1000) / 1000

/**
 * 弧の中点（直線なら弦の中点）。
 *
 * 円かどうかをアンカーだけで測ってはいけない。三角形の頂点 3 つには必ず円が
 * ぴたりと通るので、辺が直線でも「外れ 0 の円」に見えてしまう。
 */
function arcMid(from: Seg, seg: Seg): { x: number; y: number } {
  const mx = (from.x + seg.x) / 2
  const my = (from.y + seg.y) / 2
  if (seg.r === undefined) return { x: mx, y: my }
  const dx = seg.x - from.x
  const dy = seg.y - from.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return { x: mx, y: my }
  const r = Math.max(seg.r, d / 2)
  const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0))
  const sign = seg.sweep ? 1 : -1
  const cx = mx + sign * h * (-dy / d)
  const cy = my + sign * h * (dx / d)
  const ux = mx - cx
  const uy = my - cy
  const ul = Math.hypot(ux, uy) || 1
  return { x: cx + (ux / ul) * r, y: cy + (uy / ul) * r }
}

/** 輪郭を「アンカー＋弧の中点」の点列として見る */
function outlinePoints(segs: Seg[]): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < segs.length; i++) {
    out.push({ x: segs[i].x, y: segs[i].y })
    out.push(arcMid(segs[(i - 1 + segs.length) % segs.length], segs[i]))
  }
  return out
}

/**
 * 点列に円を当てる（最小二乗）。中心も半径も推定する。
 *
 * 重心からの距離で測ってはいけない。点の配置が偏っていると重心が円の中心から
 * ずれ、真円でも大きく外れて見える（実測: 6 点の穴で 39% → 中心も推定すれば 4.8%）。
 */
export function fitCircle(
  points: Array<{ x: number; y: number }>,
): { cx: number; cy: number; r: number } | null {
  const n = points.length
  if (n < 3) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let syy = 0
  let sxy = 0
  let sxz = 0
  let syz = 0
  let sz = 0
  for (const q of points) {
    const z = q.x * q.x + q.y * q.y
    sx += q.x
    sy += q.y
    sxx += q.x * q.x
    syy += q.y * q.y
    sxy += q.x * q.y
    sxz += q.x * z
    syz += q.y * z
    sz += z
  }
  const a11 = 2 * (sxx - (sx * sx) / n)
  const a12 = 2 * (sxy - (sx * sy) / n)
  const a22 = 2 * (syy - (sy * sy) / n)
  const b1 = sxz - (sx * sz) / n
  const b2 = syz - (sy * sz) / n
  const det = a11 * a22 - a12 * a12
  if (Math.abs(det) < 1e-12) return null
  const cx = (b1 * a22 - b2 * a12) / det
  const cy = (a11 * b2 - a12 * b1) / det
  const r = points.reduce((s, q) => s + Math.hypot(q.x - cx, q.y - cy), 0) / n
  return r > 1e-9 ? { cx, cy, r } : null
}

/**
 * 円のつもりで描かれた輪郭を見つけ、真円からのずれを測る。
 *
 * 「外れが小さい」だけでは足りない。**浅い弧のような小片は大きな円の上に
 * きれいに乗る**ので、外れが小さいまま通ってしまう（実測: ゴリラの顎まわりの
 * 小片が半径 1.36 の円と判定された）。円と言うからには一周していること。
 */
function measureCircles(design: LogoDesign, record: Recorder): void {
  for (const s of contoursOf(design)) {
    const pts = outlinePoints(s.segments)
    const c = fitCircle(pts)
    if (!c) continue

    const xs = pts.map((q) => q.x)
    const ys = pts.map((q) => q.y)
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    // 半径が自分の大きさに見合うこと（真円なら差し渡しの半分）
    if (c.r < span * 0.35 || c.r > span * 0.75) continue
    // 中心から見た角度に大きな隙間が無いこと
    const angles = pts.map((q) => Math.atan2(q.y - c.cy, q.x - c.cx)).sort((a, b) => a - b)
    let gap = angles[0] + Math.PI * 2 - angles[angles.length - 1]
    for (let k = 1; k < angles.length; k++) gap = Math.max(gap, angles[k] - angles[k - 1])
    if (gap > Math.PI / 2) continue

    const worst = Math.max(...pts.map((q) => Math.abs(Math.hypot(q.x - c.cx, q.y - c.cy) - c.r)))
    const off = worst / c.r
    // 円と呼べないほど歪んでいれば、円の話として報告しない
    if (off > 0.15) continue
    record(s.id, '真円からのずれ', off, 0, `r=${round(c.r)}`, 'measure')
  }
}

/** 制御点から見た外接枠 */
function frameOf(contours: Contour[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of contours) {
    for (const s of c.segments) {
      if (s.x < minX) minX = s.x
      if (s.x > maxX) maxX = s.x
      if (s.y < minY) minY = s.y
      if (s.y > maxY) maxY = s.y
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 全体の縦横比。正準比に近ければ名前を添える（近くなければ数字だけ） */
function measureProportion(design: LogoDesign, record: Recorder): void {
  const frame = frameOf(contoursOf(design))
  if (!frame) return
  const ratio = frame.w / frame.h
  let name: string | null = null
  for (const c of CANONICAL_RATIOS) {
    if (Math.abs(ratio - c.value) / c.value <= RATIO_NAME_TOL) {
      name = c.label
      break
    }
  }
  record('図形全体', '縦横比', ratio, 0, name, 'measure')
}

/**
 * 墨の重心が、外接矩形の中心からどれだけ離れているか。
 *
 * 紙面の中心に見えるのは重心のほう。離れているほど「置き方で損をしている」
 * ことになるが、**直すのは人の仕事**なので測って伝えるに留める。
 * 符号付き面積で足すので、穴（逆回りの輪郭）は自動的に差し引かれる。
 */
function measureOpticalCenter(design: LogoDesign, record: Recorder): void {
  const contours = contoursOf(design)
  const frame = frameOf(contours)
  if (!frame) return

  let area2 = 0
  let cx = 0
  let cy = 0
  for (const c of contours) {
    const p = c.segments
    for (let i = 0; i < p.length; i++) {
      const a = p[i]
      const b = p[(i + 1) % p.length]
      const cross = a.x * b.y - b.x * a.y
      area2 += cross
      cx += (a.x + b.x) * cross
      cy += (a.y + b.y) * cross
    }
  }
  if (Math.abs(area2) < 1e-6) return
  const gx = cx / (3 * area2)
  const gy = cy / (3 * area2)
  const dx = gx - (frame.x + frame.w / 2)
  const dy = gy - (frame.y + frame.h / 2)
  const off = Math.hypot(dx, dy)
  if (off < 1e-6) return
  record('図形全体', '重心と枠中心のずれ', off, 0, null, 'measure')
}

/** 半径が何種類で構成されているか（少ないほど「作図した」感が出る） */
function measureRadii(design: LogoDesign, record: Recorder): void {
  const all: number[] = []
  for (const c of contoursOf(design)) {
    for (const s of c.segments) if (s.r !== undefined) all.push(s.r)
  }
  if (all.length === 0) return
  // 8% 以内は同じ寸法とみなして数える（人が見て区別できない差）
  const sorted = [...all].sort((a, b) => a - b)
  let kinds = 1
  let head = sorted[0]
  for (const r of sorted) {
    if (Math.abs(r - head) / Math.max(head, 1e-6) > 0.08) {
      kinds++
      head = r
    }
  }
  record('図形全体', '半径の種類', kinds, 0, `弧 ${all.length} 本`, 'measure')
}

/**
 * 輪郭を含む設計を測る。**何も動かさない**。
 *
 * 含まなければ何もしない（順方向の設計は normalize の既存の経路で整えられる）。
 */
export function temper(design: LogoDesign, record: Recorder): void {
  if (contoursOf(design).length === 0) return
  measureCircles(design, record)
  measureProportion(design, record)
  measureOpticalCenter(design, record)
  measureRadii(design, record)
}
