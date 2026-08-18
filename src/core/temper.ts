import type { Contour, LogoDesign } from './dsl'
import { PHI, radiusCandidates } from './units'

/**
 * 整定（temper）——絵から起こした輪郭に、比例の規律を後から通す。
 *
 * 順方向の設計（LLM が幾何を書く）は normalize が半径や座標をモジュール系へ
 * 丸めるが、**contour には効いていなかった**。画像経路のマークは画素をなぞった
 * ものなので、半径も位置も画素の偶然そのままで、設計図に重ねた黄金比の
 * ガイドは実際には何も規定していない飾りだった（実測: レポートの
 * 「寸法のスナップ」が常に 0 件）。
 *
 * ここで効かせる三つは、いずれも「機械的に正しい」より「正しく見える」を
 * 選ぶ古典的な作法である:
 *
 *   1. 半径の統合 … 近い半径どうしを 1 つに寄せ、さらに φ 冪・単純分数へ寄せる。
 *      整って見えることの大半は「寸法が少数の値だけで構成されている」ことに
 *      由来する（units.ts の思想。線幅について unifyStrokeWidths が既に同じ
 *      ことをしている）。実測では 1 つのマークに半径が 6〜8 種あった。
 *   2. 比例の整定 … 全体の縦横比が正準比（1:1 / φ / √2 / 3:2 / 2:1）の近くに
 *      あるなら、そこへ寄せて**正確に**その比にする。近くにある時しか動かさない
 *      ので、上限 2.5% の微差にとどまる（歪みとして知覚されない範囲）。
 *   3. 光学的中心 … 外接矩形の中心ではなく**墨の重心**を原点へ置く。紙面の
 *      中心に見えるのは重心のほうで、これはロゴ制作で最も普遍的な視覚補正。
 *      設計図の同心円は原点から描かれるので、これで初めて図と合う。
 *
 * 弧は両端点を通る円弧として保たれる（半径だけを動かし、端点は動かさない）。
 * 半径が弦の半分を下回ると円弧が成立しないので、その手前で必ず止める。
 */

/** normalize と同じ記録口。整定も「寸法のスナップ」として同じ表に出す */
export type Recorder = (
  shapeId: string,
  field: string,
  from: number,
  to: number,
  label: string | null,
  reason: 'snap' | 'constraint',
) => void

/** 縦横比として名前を持つ比。近ければここへ寄せる */
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

/** 近い半径を 1 つに寄せる幅。これ以上離れていれば意図的な使い分けとみなす */
const RADIUS_CLUSTER = 0.08
/** φ 冪・単純分数へ寄せる許容差 */
const RADIUS_LADDER_TOL = 0.06
/** 縦横比を正準比へ寄せる上限。これを超える差は「その比ではない」 */
const RATIO_TOL = 0.025

type Seg = Contour['segments'][number]

function contoursOf(design: LogoDesign): Contour[] {
  return design.shapes.filter((s): s is Contour => s.kind === 'contour')
}

/** 弧の弦長。半径はこの半分を下回れない */
function chordOf(segs: Seg[], i: number): number {
  const from = segs[(i - 1 + segs.length) % segs.length]
  const seg = segs[i]
  return Math.hypot(seg.x - from.x, seg.y - from.y)
}

/**
 * 半径を少数の値へ寄せる。
 *
 * まずマーク全体で近い半径どうしを束ね（種類を減らし）、束ねた代表値を
 * φ 冪・単純分数へ寄せる。個々の弧ではなく**マーク全体で**束ねるのが要点で、
 * 輪郭ごとに独立して丸めると、外形と穴で僅かに違う半径が残る。
 */
function harmonizeRadii(design: LogoDesign, record: Recorder): void {
  const contours = contoursOf(design)
  const all: number[] = []
  for (const c of contours) for (const s of c.segments) if (s.r !== undefined) all.push(s.r)
  if (all.length === 0) return

  // 昇順に見て、直前の代表値との相対差が RADIUS_CLUSTER 以内なら同じ束にする
  const sorted = [...all].sort((a, b) => a - b)
  const clusters: number[][] = []
  for (const r of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(r - last[0]) / Math.max(last[0], 1e-6) <= RADIUS_CLUSTER) last.push(r)
    else clusters.push([r])
  }

  // 束の代表値は平均。そこからさらにモジュール系の値へ寄せる。
  //
  // 寄せ先は**相対差**で選ぶ。units の snap は許容差の基準に 0.5 の下限を
  // 持つので、小さな半径ほど許容が甘くなる（実測: 瞳の半径 0.071 が 0.088 へ
  // 24% も動いた）。目や鼻のような小さな部品は、比率で見て初めて「わずかな
  // 調整」と言える。
  const ladder = radiusCandidates()
  const targets = clusters.map((group) => {
    const mean = group.reduce((a, b) => a + b, 0) / group.length
    let best: { value: number; label: string } | null = null
    let bestRel = Infinity
    for (const c of ladder) {
      const rel = Math.abs(c.value - mean) / Math.max(mean, 1e-9)
      if (rel < bestRel) {
        bestRel = rel
        best = c
      }
    }
    if (best && bestRel <= RADIUS_LADDER_TOL) return { group, value: best.value, label: best.label }
    // 寄せ先が遠いなら、束の中だけ揃える（種類は減るが値は動かしすぎない）
    return { group, value: mean, label: null as string | null }
  })

  /** ある半径が属する束の目標値 */
  const targetFor = (r: number) => {
    for (const t of targets) {
      if (r >= t.group[0] - 1e-9 && r <= t.group[t.group.length - 1] + 1e-9) return t
    }
    return null
  }

  for (const c of contours) {
    for (let i = 0; i < c.segments.length; i++) {
      const seg = c.segments[i]
      if (seg.r === undefined) continue
      const t = targetFor(seg.r)
      if (!t) continue
      const min = (chordOf(c.segments, i) / 2) * 1.0005
      if (t.value >= min) {
        seg.r = t.value
        continue
      }
      // 目標が弦に対して小さすぎて円弧が成立しない弧。固有の値を与えると
      // その弧だけ別の半径になり「少数の値で構成する」に反するので、
      // **既にある目標値の中から**成立する最小のものを選ぶ（種類は増えない）
      const fallback = targets
        .map((x) => x.value)
        .filter((v) => v >= min)
        .sort((a, b) => a - b)[0]
      if (fallback !== undefined) seg.r = fallback
    }
  }

  // 記録は束ごとに 1 件。弧ごとに出すと表が数十行になり、何が起きたのか
  // かえって読めなくなる（実測: 1 マークで 74 件）
  for (const t of targets) {
    const mean = t.group.reduce((a, b) => a + b, 0) / t.group.length
    if (Math.abs(mean - t.value) < 1e-9 && t.group.length === 1) continue
    record(`半径 ×${t.group.length}`, '半径', mean, t.value, t.label, 'snap')
  }
}

/** 制御点から見た外接枠。弧の膨らみは含まないが、比の判断には十分 */
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

/**
 * 全体の縦横比を正準比へ寄せる。
 *
 * 既に近いときしか動かさないので、拡大率の差は最大でも 2.5%。円弧は
 * 縦横で違う倍率をかけると厳密には楕円弧になるが、この差では円弧との
 * ずれが半径の 1% 未満に収まる（DSL は円弧しか持てないので、半径には
 * 縦横の相乗平均をかけて円のまま保つ）。
 */
function temperProportion(design: LogoDesign, record: Recorder): void {
  const contours = contoursOf(design)
  const frame = frameOf(contours)
  if (!frame) return

  const ratio = frame.w / frame.h
  let best: { value: number; label: string } | null = null
  let bestDist = Infinity
  for (const c of CANONICAL_RATIOS) {
    const d = Math.abs(ratio - c.value) / c.value
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  if (!best || bestDist > RATIO_TOL || bestDist < 1e-6) return

  // 面積を保ったまま比だけを変える（片側だけ伸ばすと大きさの印象が変わる）。
  // 半径は**その弧の弦が伸びた率**で伸ばす。弦に対する半径の比が変わらないので
  // 弧の膨らみ具合が保たれ、「半径が弦の半分を下回る（円弧が成立しない）」も
  // 起こりえない。一律に据え置くと、伸びた側の弧だけが個別の下限へ張り付き、
  // 半径の種類が却って増える（実測: 8 → 9）。
  const k = Math.sqrt(best.value / ratio)
  const cx = frame.x + frame.w / 2
  const cy = frame.y + frame.h / 2

  for (const c of contours) {
    const chords = c.segments.map((_, i) => chordOf(c.segments, i))
    for (const s of c.segments) {
      s.x = cx + (s.x - cx) * k
      s.y = cy + (s.y - cy) / k
    }
    for (let i = 0; i < c.segments.length; i++) {
      const seg = c.segments[i]
      if (seg.r === undefined) continue
      const before = chords[i]
      const after = chordOf(c.segments, i)
      if (before > 1e-9 && after > 1e-9) seg.r *= after / before
    }
  }
  record('図形全体', '縦横比', ratio, best.value, best.label, 'snap')
}

/**
 * 墨の重心を原点へ置く。
 *
 * 符号付き面積で足すので、穴（逆回りの輪郭）は自動的に差し引かれる
 * （実測: 復元した輪郭は外形が正・穴が負で一貫していた）。弧の膨らみは
 * 無視して弦の多角形として測る——重心の位置は塊の配置で決まるので、
 * 端の膨らみの差は結果をほとんど動かさない。
 */
function centerOptically(design: LogoDesign, record: Recorder): void {
  const contours = contoursOf(design)
  if (contours.length === 0) return

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
  // 面積が消えた（巻き方向が揃っていない等）なら、下手に動かさない
  if (Math.abs(area2) < 1e-6) return
  const gx = cx / (3 * area2)
  const gy = cy / (3 * area2)
  if (Math.hypot(gx, gy) < 1e-6) return

  for (const c of contours) {
    for (const s of c.segments) {
      s.x -= gx
      s.y -= gy
    }
  }
  record('図形全体', '光学的中心 x', gx, 0, null, 'snap')
  record('図形全体', '光学的中心 y', gy, 0, null, 'snap')
}

/**
 * 輪郭を含む設計に整定を通す。含まなければ何もしない（順方向の設計は
 * normalize の既存の経路で既に整えられている）。
 *
 * 順序が要点: 全体の形を先に決め（比例）、それから寸法を丸め（半径）、
 * 最後に置く（中心）。逆にすると、丸めた値が後の変形でずれる。
 */
export function temper(design: LogoDesign, record: Recorder): void {
  if (contoursOf(design).length === 0) return
  temperProportion(design, record)
  harmonizeRadii(design, record)
  centerOptically(design, record)
}
