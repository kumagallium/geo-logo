import {
  hasCenter,
  radiusOf,
  type Centered,
  type LogoDesign,
  type Shape,
} from './dsl'
import { coordCandidates, radiusCandidates, snap, snapAngle } from './units'

export type NormalizeNote = {
  shapeId: string
  field: string
  from: number
  to: number
  label: string | null
  reason: 'snap' | 'constraint'
}

export type NormalizeResult = {
  design: LogoDesign
  notes: NormalizeNote[]
  unresolved: string[]
}

const RADIUS_TOL = 0.09
const COORD_TOL = 0.07
const SOLVER_PASSES = 240

type Vec = { x: number; y: number }

function center(s: Centered): Vec {
  return { x: s.cx, y: s.cy }
}

/**
 * ①LLM が返す数値をモジュール系のきれいな値へスナップし、
 * ②宣言された幾何制約（接する／同心／整列／円周上）を緩和法で満たすまで中心を動かす。
 *
 * 順序が重要: 半径を先に確定してから中心を動かす。逆にすると
 * 接点関係が壊れた状態で丸められ、「ほぼ接している」ズレが残る。
 */
export function normalize(input: LogoDesign): NormalizeResult {
  const design: LogoDesign = structuredClone(input)
  const notes: NormalizeNote[] = []
  const unresolved: string[] = []

  const byId = new Map<string, Shape>()
  for (const s of design.shapes) {
    if (byId.has(s.id)) unresolved.push(`シェイプ id が重複: ${s.id}`)
    byId.set(s.id, s)
  }

  const radii = radiusCandidates()
  const coords = coordCandidates()

  const record = (
    shapeId: string,
    field: string,
    from: number,
    to: number,
    label: string | null,
    reason: NormalizeNote['reason'],
  ) => {
    if (Math.abs(from - to) < 1e-9) return
    notes.push({ shapeId, field, from, to, label, reason })
  }

  // --- Step 1: サイズのスナップ ---
  for (const s of design.shapes) {
    const snapSize = (field: string, v: number) => {
      const r = snap(v, radii, RADIUS_TOL)
      record(s.id, field, v, r.value, r.label, 'snap')
      return r.value
    }
    // 角度も丸める。半径だけ整えても、47° や -53° が残ると構成が濁る。
    const snapDeg = (field: string, v: number) => {
      const r = snapAngle(v)
      record(s.id, field, v, r.value, r.label, 'snap')
      return r.value
    }
    switch (s.kind) {
      case 'circle':
        s.r = snapSize('r', s.r)
        break
      case 'ring':
        s.r = snapSize('r', s.r)
        s.w = snapSize('w', s.w)
        if (s.w >= s.r) {
          s.w = s.r * 0.5
          unresolved.push(`${s.id}: 線幅が半径以上だったため r/2 に補正`)
        }
        break
      case 'wedge':
        s.r = snapSize('r', s.r)
        s.a0 = snapDeg('a0', s.a0)
        s.a1 = snapDeg('a1', s.a1)
        break
      case 'arc':
        s.r = snapSize('r', s.r)
        s.w = snapSize('w', s.w)
        s.a0 = snapDeg('a0', s.a0)
        s.a1 = snapDeg('a1', s.a1)
        break
      case 'bar':
        s.w = snapSize('w', s.w)
        break
      case 'rect':
        s.w = snapSize('w', s.w)
        s.h = snapSize('h', s.h)
        if (s.radius != null) s.radius = snapSize('radius', s.radius)
        if (s.rotate != null) s.rotate = snapDeg('rotate', s.rotate)
        break
      case 'poly':
        break
    }
  }

  // --- Step 1.5: 線の太さを揃える ---
  // 幾何ロゴでは線の太さが揃っていることが「整って見える」ことの大半を占める。
  // 0.5 と 0.618 のように僅かに違う値が混ざると、意図の無いばらつきに見える。
  // 近い太さ同士だけを 1 つに寄せる（明確に違う太さは意図的な使い分けとして残す）。
  unifyStrokeWidths(design, record)

  // --- Step 2: 座標のスナップ（制約前の初期位置合わせ）---
  // pinned は「作者が意図して置いた点」なので一切触らない。
  for (const s of design.shapes) {
    if (hasCenter(s) && !s.pinned) {
      const cx = snap(s.cx, coords, COORD_TOL)
      const cy = snap(s.cy, coords, COORD_TOL)
      record(s.id, 'cx', s.cx, cx.value, cx.label, 'snap')
      record(s.id, 'cy', s.cy, cy.value, cy.label, 'snap')
      s.cx = cx.value
      s.cy = cy.value
    }
  }

  // --- Step 3: 制約の緩和解法 ---
  const centered = new Map<string, Centered>()
  for (const s of design.shapes) if (hasCenter(s)) centered.set(s.id, s)

  const before = new Map<string, Vec>()
  for (const [k, s] of centered) before.set(k, center(s))

  const pick = (id: string, ctx: string): Centered | null => {
    const s = centered.get(id)
    if (!s) {
      unresolved.push(`${ctx}: 中心を持つシェイプ "${id}" が見つからない`)
      return null
    }
    return s
  }

  // 同一制約を毎パス評価し、違反量の半分ずつ両側を寄せる（Position Based Dynamics 相当）
  for (let pass = 0; pass < SOLVER_PASSES; pass++) {
    const relax = 0.5

    for (const c of design.constraints) {
      switch (c.type) {
        case 'tangent': {
          const a = pick(c.a, 'tangent')
          const b = pick(c.b, 'tangent')
          if (!a || !b) break
          const target =
            c.mode === 'external'
              ? radiusOf(a) + radiusOf(b)
              : Math.abs(radiusOf(a) - radiusOf(b))
          moveToDistance(a, b, target, relax)
          break
        }
        case 'concentric': {
          const a = pick(c.a, 'concentric')
          const b = pick(c.b, 'concentric')
          if (!a || !b) break
          moveToDistance(a, b, 0, relax)
          break
        }
        case 'onCircle': {
          const p = pick(c.point, 'onCircle')
          const circle = pick(c.circle, 'onCircle')
          if (!p || !circle) break
          moveToDistance(p, circle, radiusOf(circle), relax)
          break
        }
        case 'align': {
          const members = c.ids
            .map((i) => pick(i, 'align'))
            .filter((s): s is Centered => s !== null)
          if (members.length < 2) break
          const key = c.axis === 'x' ? 'cx' : 'cy'
          const movable = members.filter((m) => !m.pinned)
          const anchor = members.find((m) => m.pinned)
          const target = anchor
            ? anchor[key]
            : members.reduce((sum, m) => sum + m[key], 0) / members.length
          for (const m of movable) m[key] += (target - m[key]) * relax
          break
        }
      }
    }
  }

  // 解いたあと、端数をグリッドへ戻して見た目の数値を整える。
  // ただし丸めは制約を壊しうるので、1 シェイプずつ「制約の総誤差が悪化しないか」
  // を実測し、悪化するなら差し戻す。整数座標より幾何の正しさを優先する。
  const baseline = constraintError(design)
  for (const [, s] of centered) {
    if (s.pinned) continue
    const cx = snap(s.cx, coords, 0.015)
    const cy = snap(s.cy, coords, 0.015)
    if (!cx.changed && !cy.changed) continue

    const prevX = s.cx
    const prevY = s.cy
    s.cx = cx.value
    s.cy = cy.value
    if (constraintError(design) > baseline + 1e-9) {
      s.cx = prevX
      s.cy = prevY
    }
  }

  for (const [id, s] of centered) {
    const b = before.get(id)!
    record(id, 'cx', b.x, s.cx, null, 'constraint')
    record(id, 'cy', b.y, s.cy, null, 'constraint')
  }

  // --- Step 4: bar の端点束縛を反映 ---
  for (const s of design.shapes) {
    if (s.kind !== 'bar') continue
    if (s.fromRef) {
      const t = centered.get(s.fromRef)
      if (t) {
        s.x1 = t.cx
        s.y1 = t.cy
      } else {
        unresolved.push(`${s.id}: fromRef "${s.fromRef}" を解決できない`)
      }
    }
    if (s.toRef) {
      const t = centered.get(s.toRef)
      if (t) {
        s.x2 = t.cx
        s.y2 = t.cy
      } else {
        unresolved.push(`${s.id}: toRef "${s.toRef}" を解決できない`)
      }
    }
    if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 1e-6) {
      unresolved.push(`${s.id}: 始点と終点が一致している`)
    }
  }

  // --- Step 5: 参照整合性 ---
  const groupIds = new Set(design.groups.map((g) => g.id))
  const refExists = (ref: string) => byId.has(ref) || groupIds.has(ref)
  for (const g of design.groups) {
    for (const st of g.steps) {
      if (!byId.has(st.ref)) unresolved.push(`group ${g.id}: シェイプ "${st.ref}" が存在しない`)
    }
  }
  for (const p of design.parts) {
    for (const st of p.steps) {
      if (!refExists(st.ref)) unresolved.push(`part ${p.id}: 参照 "${st.ref}" が存在しない`)
    }
    if (p.steps[0]?.op !== 'add') {
      unresolved.push(`part ${p.id}: 最初のステップは add である必要がある`)
    }
  }

  return { design, notes, unresolved }
}

type StrokeShape = { id: string; get: () => number; set: (v: number) => void }

/**
 * 線状シェイプ（bar / ring / arc）の太さをクラスタリングして揃える。
 *
 * 「近い」の閾値は 25%。これを超える差は意図的な太さの使い分けとみなして残す。
 * 各クラスタの代表値には中央値を使う（平均は外れ値に引きずられる）。
 */
function unifyStrokeWidths(
  design: LogoDesign,
  record: (
    shapeId: string,
    field: string,
    from: number,
    to: number,
    label: string | null,
    reason: NormalizeNote['reason'],
  ) => void,
): void {
  const strokes: StrokeShape[] = []
  for (const s of design.shapes) {
    if (s.kind === 'bar' || s.kind === 'ring' || s.kind === 'arc') {
      strokes.push({ id: s.id, get: () => s.w, set: (v) => (s.w = v) })
    }
  }
  if (strokes.length < 2) return

  const sorted = [...strokes].sort((a, b) => a.get() - b.get())
  let cluster: StrokeShape[] = [sorted[0]]

  const flush = () => {
    if (cluster.length < 2) return
    const values = cluster.map((c) => c.get()).sort((a, b) => a - b)
    const median = values[Math.floor(values.length / 2)]
    for (const member of cluster) {
      const before = member.get()
      if (Math.abs(before - median) < 1e-9) continue
      member.set(median)
      record(member.id, 'w', before, median, '線幅の統一', 'snap')
    }
  }

  for (const s of sorted.slice(1)) {
    const base = cluster[0].get()
    if (s.get() / Math.max(base, 1e-9) <= 1.25) {
      cluster.push(s)
    } else {
      flush()
      cluster = [s]
    }
  }
  flush()
}

/** a,b の中心間距離を target に近づける。pinned 側は動かさない。 */
function moveToDistance(a: Centered, b: Centered, target: number, relax: number) {
  let dx = b.cx - a.cx
  let dy = b.cy - a.cy
  let dist = Math.hypot(dx, dy)

  if (dist < 1e-9) {
    if (target < 1e-9) return
    // 完全一致から引き離す必要がある場合は任意方向へ微小に押し出す
    dx = 1
    dy = 0
    dist = 1e-9
  }

  const error = dist - target
  if (Math.abs(error) < 1e-9) return

  const ux = dx / dist
  const uy = dy / dist
  const aFree = !a.pinned
  const bFree = !b.pinned
  if (!aFree && !bFree) return

  const share = aFree && bFree ? 0.5 : 1
  const step = error * relax

  if (aFree) {
    a.cx += ux * step * share
    a.cy += uy * step * share
  }
  if (bFree) {
    b.cx -= ux * step * share
    b.cy -= uy * step * share
  }
}

export type Residual = { label: string; error: number }

/** 各制約の違反量を実測する。ソルバーの停止判定と UI 表示の両方が使う。 */
export function constraintResiduals(design: LogoDesign): Residual[] {
  const centered = new Map<string, Centered>()
  for (const s of design.shapes) if (hasCenter(s)) centered.set(s.id, s)
  const out: Residual[] = []

  for (const c of design.constraints) {
    if (c.type === 'align') {
      const key = c.axis === 'x' ? 'cx' : 'cy'
      const vals = c.ids.map((i) => centered.get(i)?.[key]).filter((v): v is number => v != null)
      if (vals.length < 2) continue
      out.push({
        label: `align(${c.ids.join(',')})`,
        error: Math.max(...vals) - Math.min(...vals),
      })
      continue
    }

    const aId = c.type === 'onCircle' ? c.point : c.a
    const bId = c.type === 'onCircle' ? c.circle : c.b
    const a = centered.get(aId)
    const b = centered.get(bId)
    if (!a || !b) continue

    const dist = Math.hypot(b.cx - a.cx, b.cy - a.cy)
    const target =
      c.type === 'concentric'
        ? 0
        : c.type === 'onCircle'
          ? radiusOf(b)
          : c.mode === 'external'
            ? radiusOf(a) + radiusOf(b)
            : Math.abs(radiusOf(a) - radiusOf(b))

    out.push({ label: `${c.type}(${aId},${bId})`, error: Math.abs(dist - target) })
  }
  return out
}

/** 制約違反の総量。丸め操作の可否判定に使う。 */
export function constraintError(design: LogoDesign): number {
  return constraintResiduals(design).reduce((sum, r) => sum + r.error, 0)
}

/** 制約が実際に満たされているかの検証（テスト・UI 表示用） */
export function checkConstraints(design: LogoDesign, epsilon = 1e-3): string[] {
  return constraintResiduals(design)
    .filter((r) => r.error > epsilon)
    .map((r) => `${r.label} の誤差 ${r.error.toFixed(4)}`)
}
