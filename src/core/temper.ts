import type { Contour, LogoDesign } from './dsl'
import { PHI, radiusCandidates } from './units'

/**
 * 整定（temper）——絵から起こした輪郭を、規則の側へ寄せ直す。
 *
 * この道具は**なぞる**のではなく**作図し直す**ものである。ラフには「本当は
 * こうしたかった」規則が透けており、清書とはそれを見抜いて言い切ることを言う。
 * 実装としてはひとつの方針で貫ける:
 *
 *     「ほぼ○○」なら「まさに○○」にする。
 *     判定はマークの大きさに対する相対誤差で測り、寄せた事実は必ず記録する。
 *
 * 何を規則とみなすかで三つの層に分かれるが、考え方は同じもの:
 *
 *   - 寸法 … 半径を少数の値へ（φ 冪・単純分数）。整って見えることの大半は
 *     「寸法が少数の値だけで構成されている」ことに由来する（units.ts の思想）。
 *   - 比例 … 全体の縦横比が正準比（1:1 / φ / √2 / 3:2）の近くにあるなら、
 *     そこへ寄せて正確にその比にする。
 *   - 形 …… ほぼ円の輪郭は円にする。円を「ほぼ円のままの自由曲線」で置くと、
 *     どれだけ寸法を整えても濁って見える（実測: 鍵の弓部の穴が真円から 4.8%
 *     ずれ、円ではなく角の取れた塊に見えた）。
 *
 * 加えて、幾何ではなく見え方の側の作法をひとつ:
 *
 *   - 光学的中心 … 外接矩形の中心ではなく**墨の重心**を原点へ置く。紙面の
 *     中心に見えるのは重心のほうで、これはロゴ制作で最も普遍的な視覚補正。
 *     設計図の同心円は原点から描かれるので、これで初めて図と合う。
 *
 * 「ほぼ直線の連なりは直線にする」も同じ方針だが、当てはめの直後・継ぎ目を
 * 均す前に効かせる必要があるので core/trace.ts の straightenRuns に置いてある。
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

/**
 * 円とみなす上限（自分の半径に対する外れの割合）。
 *
 * 生成画像の円は素で数 % ずれる（実測: 鍵の弓部の穴が 4.8%）。厳しくすると
 * 円が円にならず、緩めると卵や角丸の四角まで円に潰れる。8% は「円のつもりで
 * 描かれたもの」と「別の形」の間にある。
 */
const CIRCLE_TOL = 0.08

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

/** 弧の両端の接線の向き。直線なら弦の向き */
function tangents(from: Seg, seg: Seg): readonly [number, number] | null {
  if (seg.r === undefined) {
    const a = Math.atan2(seg.y - from.y, seg.x - from.x)
    return [a, a] as const
  }
  const dx = seg.x - from.x
  const dy = seg.y - from.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return null
  const r = Math.max(seg.r, d / 2)
  const h = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0))
  const sign = seg.sweep ? 1 : -1
  const cx = (from.x + seg.x) / 2 + sign * h * (-dy / d)
  const cy = (from.y + seg.y) / 2 + sign * h * (dx / d)
  const t = (px: number, py: number) => Math.atan2(sign * (px - cx), -sign * (py - cy))
  return [t(from.x, from.y), t(seg.x, seg.y)] as const
}

/**
 * 継ぎ目での接線の折れの合計（ラジアン）。
 *
 * 半径を動かすと弧の膨らみが変わり、継ぎ目の接線がずれる。輪郭は当てはめの
 * 段で G1 連続に均してあるので、**整定がそれを崩してはいけない**（実測: 素朴に
 * 寄せると継ぎ目の折れが平均 6.4° → 6.7° に悪化した）。寄せる前後でこれを
 * 比べ、悪くなるなら寄せない。
 */
function jointBreak(segs: Seg[]): number {
  let sum = 0
  for (let i = 0; i < segs.length; i++) {
    const a = tangents(segs[(i - 1 + segs.length) % segs.length], segs[i])
    const b = tangents(segs[i], segs[(i + 1) % segs.length])
    if (!a || !b) continue
    sum += Math.abs(Math.atan2(Math.sin(b[0] - a[1]), Math.cos(b[0] - a[1])))
  }
  return sum
}

/**
 * 弧の中点（直線なら弦の中点）。
 *
 * 円かどうかをアンカーだけで測ってはいけない。三角形の頂点 3 つには必ず円が
 * ぴたりと通るので、辺が直線でも「外れ 0 の円」に見えてしまう。辺の膨らみまで
 * 見て初めて、円と多角形が分かれる。
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
function fitCircle(points: Array<{ x: number; y: number }>): { cx: number; cy: number; r: number } | null {
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
 * ほぼ円の輪郭を、円そのものに置き換える。
 *
 * この道具の値打ちは「円と線で作図する」ことにある。円のつもりで描かれたものを
 * 「ほぼ円の自由曲線」のまま残すと、寸法をどれだけ整えても濁って見えるし、
 * 設計図にも円が現れない。DSL には円の種類があるのだから、円は円として置く。
 *
 * 置き換えると輪郭は 1 つの値（半径）になるので、この後の半径の統合や
 * normalize のモジュール系スナップがそのまま効く——規則の側へ寄せるほど、
 * 後段の規律が噛み合う。
 */
function circularize(design: LogoDesign, record: Recorder): void {
  for (let i = 0; i < design.shapes.length; i++) {
    const s = design.shapes[i]
    if (s.kind !== 'contour') continue
    // アンカーだけでなく辺の膨らみも含めて測る。点が 3 つでも、輪郭として
    // 円なら円と言える（実測: 環に並ぶ小さな点は 3〜4 点で、アンカーだけの
    // 判定では円にならず、角の残った塊のまま残っていた）
    const pts = outlinePoints(s.segments)
    const c = fitCircle(pts)
    if (!c) continue
    const worst = Math.max(...pts.map((q) => Math.abs(Math.hypot(q.x - c.cx, q.y - c.cy) - c.r)))
    const off = worst / c.r
    if (off > CIRCLE_TOL) continue

    // 外れの小ささだけでは足りない。**浅い弧のような小片は、大きな円の上に
    // きれいに乗る**ので判定を通ってしまい、小片が巨大な円に化ける
    // （実測: ゴリラの顎まわりの小片が半径 1.36 の円になり、頭の下に元画像に
    // 無い楕円が現れて一致率が 74% まで落ちた）。
    //
    // 円と言うからには、輪郭がその円を**一周している**こと。
    //   - 半径が自分の大きさに見合う（真円なら差し渡しの半分）
    //   - 中心から見た角度に大きな隙間が無い
    const xs = pts.map((q) => q.x)
    const ys = pts.map((q) => q.y)
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    if (c.r < span * 0.35 || c.r > span * 0.75) continue
    const angles = pts.map((q) => Math.atan2(q.y - c.cy, q.x - c.cx)).sort((a, b) => a - b)
    let gap = angles[0] + Math.PI * 2 - angles[angles.length - 1]
    for (let k = 1; k < angles.length; k++) gap = Math.max(gap, angles[k] - angles[k - 1])
    if (gap > Math.PI / 2) continue
    design.shapes[i] = {
      kind: 'circle',
      id: s.id,
      cx: round(c.cx),
      cy: round(c.cy),
      r: round(c.r),
      // 当てた位置がそのまま答え。この後 normalize の座標スナップに動かされると、
      // 弓部と穴のような**関係**が崩れる（穴だけがグリッドへ寄って偏心する）
      pinned: true,
    } as LogoDesign['shapes'][number]
    record(s.id, '円へ整形', off, 0, `r=${round(c.r)}`, 'snap')
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000

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

  const applied = new Set<number>()
  for (const c of contours) {
    const before = jointBreak(c.segments)
    const saved = c.segments.map((s) => s.r)
    const used: number[] = []

    for (let i = 0; i < c.segments.length; i++) {
      const seg = c.segments[i]
      if (seg.r === undefined) continue
      const t = targetFor(seg.r)
      if (!t) continue
      const min = (chordOf(c.segments, i) / 2) * 1.0005
      if (t.value >= min) {
        seg.r = t.value
        used.push(t.value)
        continue
      }
      // 目標が弦に対して小さすぎて円弧が成立しない弧。固有の値を与えると
      // その弧だけ別の半径になり「少数の値で構成する」に反するので、
      // **既にある目標値の中から**成立する最小のものを選ぶ（種類は増えない）
      const fallback = targets
        .map((x) => x.value)
        .filter((v) => v >= min)
        .sort((a, b) => a - b)[0]
      if (fallback !== undefined) {
        seg.r = fallback
        used.push(fallback)
      }
    }

    // 滑らかさを損なうなら、この輪郭は寄せない。比例の見栄えより、
    // 継ぎ目が流れていることのほうが目に見える。
    //
    // 許容は継ぎ目 1 本あたり 0.2°。寸法を動かせば継ぎ目は必ず僅かに動くので
    // 完全禁止では何も寄せられないが、実測で問題になった悪化（1 本あたり
    // 0.3°）は弾ける幅にする。
    const budget = ((0.2 * Math.PI) / 180) * c.segments.length
    const after = jointBreak(c.segments)
    if (after > before + budget) {
      c.segments.forEach((s, i) => {
        s.r = saved[i]
      })
    } else {
      for (const v of used) applied.add(v)
    }
  }

  // 記録は束ごとに 1 件。弧ごとに出すと表が数十行になり、何が起きたのか
  // かえって読めなくなる（実測: 1 マークで 74 件）
  for (const t of targets) {
    if (!applied.has(t.value)) continue
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

  // 手描きの絵は規則へ寄せない。ゆらぎが表現そのものなので、円にすれば筆勢が
  // 消える（実測: 円相が真円 3 つに潰れた）。ただし置き方と全体の枠は描いた線に
  // 触らないので、そこだけは通す
  // 比例 → 寸法 の順。比例の整定は弦の伸び率で半径を動かすので、先に寸法を
  // 揃えても後からばらける（実測: 1 つに寄せた半径が 1.0025 と 0.9957 に分裂）。
  // 形を決めてから、その形の寸法を量る
  temperProportion(design, record)
  if (!design.freehand) harmonizeRadii(design, record)
  centerOptically(design, record)
  // 円にするのは**最後**。比例も中心合わせも輪郭だけを動かすので、先に円へ
  // 変えると、その円だけが取り残されて位置関係が壊れる（実測: 鍵の弓部の穴が
  // 上へずれて三日月になった）。全部動かし終えてから、形を言い切る
  if (!design.freehand) circularize(design, record)
}
