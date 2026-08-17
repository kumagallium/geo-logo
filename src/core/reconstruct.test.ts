import { describe, expect, it } from 'vitest'
import { build } from './build'
import { designSchema, type LogoDesign } from './dsl'
import { decodeGray, encodeGrayPng } from './png'
import { rasterizeGray } from './raster'
import {
  buildFromContours,
  contoursFromMask,
  contoursFromRaster,
  fidelity,
  reconstruct,
  symmetrizeMask,
} from './reconstruct'
import { fitToModule, traceArcs } from './trace'

/** width×height の明度配列を作る。ink(x,y) が真なら墨（0） */
const canvas = (size: number, ink: (x: number, y: number) => boolean): Uint8Array => {
  const gray = new Uint8Array(size * size).fill(255)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (ink(x, y)) gray[y * size + x] = 0
  }
  return gray
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number) =>
  (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r

describe('画素から輪郭', () => {
  it('塗った矩形は 1 本の閉じた輪になる', () => {
    // 画素をなぞる方式は斜めで穴が開く。隙間を辿るので閉じることは構成上保証される
    const loops = contoursFromMask((x, y) => x >= 2 && x < 8 && y >= 3 && y < 7, 12, 12)
    expect(loops).toHaveLength(1)
    const loop = loops[0]
    expect(loop[0]).toEqual(loop[loop.length - 1] ? loop[0] : loop[0])
    // 周長は 2*(6+4) = 20
    expect(loop).toHaveLength(20)
  })

  it('穴のあいた形は外周と抜きの 2 本になる', () => {
    const loops = contoursFromMask(
      (x, y) => x >= 2 && x < 10 && y >= 2 && y < 10 && !(x >= 5 && x < 7 && y >= 5 && y < 7),
      12,
      12,
    )
    expect(loops).toHaveLength(2)
  })

  it('斜めにだけ触れる 2 つは切り離す', () => {
    // 島の判定（islandsOf）が 4 近傍なので、輪郭も同じ見方でなければ数が食い違う
    const loops = contoursFromMask((x, y) => (x === 2 && y === 2) || (x === 3 && y === 3), 8, 8)
    expect(loops).toHaveLength(2)
  })

  it('縁に接した形でも閉じる', () => {
    const loops = contoursFromMask((x, y) => x < 4 && y < 4, 8, 8)
    expect(loops).toHaveLength(1)
  })
})

describe('輪郭の取り出し', () => {
  it('円板は 1 本の塗りとして出る', () => {
    const contours = contoursFromRaster(canvas(128, disc(64, 64, 40)), 128)
    expect(contours).toHaveLength(1)
    expect(contours[0].solid).toBe(true)
    // 打ち直した点が円周に乗っている。境界は画素の外側の角を通るので外へ出る一方、
    // 階段を落とすときに角が弦で削られて内へ戻る。差し引き 1 画素の帯に収まる
    for (const p of contours[0].points) {
      const r = Math.hypot(p.x - 64, p.y - 64)
      expect(r).toBeGreaterThan(39.5)
      expect(r).toBeLessThan(41.0)
    }
  })

  it('環は外周と抜きに分かれる', () => {
    const ring = canvas(128, (x, y) => disc(64, 64, 48)(x, y) && !disc(64, 64, 24)(x, y))
    const contours = contoursFromRaster(ring, 128)
    expect(contours).toHaveLength(2)
    expect(contours.filter((c) => c.solid)).toHaveLength(1)
    expect(contours.filter((c) => !c.solid)).toHaveLength(1)
  })

  it('小さすぎる屑は捨てる', () => {
    // 生成画像には滲みが乗る。大きい塊に対する比で切る（絶対値だと小さなマークごと消える）
    const dirty = canvas(128, (x, y) => disc(64, 64, 40)(x, y) || (x === 4 && y === 4))
    expect(contoursFromRaster(dirty, 128)).toHaveLength(1)
  })

  it('階段は落ちる（斜辺が段のまま残らない）', () => {
    // 画素の境界は 1 画素刻み。そのまま弧を当てると段そのものに弧が当たる
    const wedge = canvas(128, (x, y) => y > 20 && y < 108 && x > 20 && x < 20 + (y - 20))
    const design = buildFromContours(contoursFromRaster(wedge, 128), { tolerance: 0.02 })
    const contour = design.shapes.find((s) => s.kind === 'contour')
    if (contour?.kind !== 'contour') throw new Error('輪郭が無い')
    expect(contour.segments.length).toBeLessThan(12)
  })
})

describe('入れ子', () => {
  // 手で書く経路では抜きが必ず最後に効くので、囲いの中へ塊を置けなかった。
  // 復元では包含の深さが画素から分かるので、入れ子がそのまま演算順になる
  it('深さ 0 / 1 / 2 が 足す・抜く・足す になる', () => {
    const nested = canvas(160, (x, y) => {
      if (disc(80, 80, 20)(x, y)) return true // 深さ 2：環の中の塊
      if (disc(80, 80, 45)(x, y)) return false // 深さ 1：抜き
      return disc(80, 80, 70)(x, y) // 深さ 0：外周
    })
    const contours = contoursFromRaster(nested, 160)
    expect(contours).toHaveLength(3)

    const design = buildFromContours(contours, { tolerance: 0.02 })
    expect(design.parts[0].steps.map((s) => s.op)).toEqual(['add', 'sub', 'add'])

    // 実際に中身が残っている（輪郭 3 本＝外周・抜き・中の塊）
    const parsed = designSchema.parse(design)
    const built = build(parsed)
    expect(built.parts[0].pathData.match(/M/g)?.length).toBe(3)
  })
})

describe('往復', () => {
  const roundTrip = (design: LogoDesign, tolerance = 0.012) => {
    const src = rasterizeGray(build(designSchema.parse(design)), { size: 512, samples: 3 })
    const back = reconstruct(src.gray, src.size, src.size, { tolerance })
    const built = build(designSchema.parse(back))
    return { fidelity: fidelity(src.gray, rasterizeGray(built, { size: src.size }).gray), back }
  }

  const design = (shapes: LogoDesign['shapes'], steps: Array<{ op: 'add' | 'sub'; ref: string }>) =>
    designSchema.parse({ name: '検査', concept: '検査', shapes, parts: [{ id: 'mark', steps }] })

  it('円板は 98% 以上で戻る', () => {
    const d = design([{ kind: 'circle', id: 'a', cx: 0, cy: 0, r: 2 }], [{ op: 'add', ref: 'a' }])
    expect(roundTrip(d).fidelity).toBeGreaterThan(0.98)
  })

  it('抜きのある形も戻る', () => {
    const d = design(
      [
        { kind: 'circle', id: 'a', cx: 0, cy: 0, r: 2 },
        { kind: 'circle', id: 'b', cx: 0.4, cy: -0.3, r: 0.6 },
      ],
      [
        { op: 'add', ref: 'a' },
        { op: 'sub', ref: 'b' },
      ],
    )
    const { fidelity: f, back } = roundTrip(d)
    expect(f).toBeGreaterThan(0.97)
    expect(back.parts[0].steps.map((s) => s.op)).toEqual(['add', 'sub'])
  })

  it('許容誤差が抽象度のレバーになる', () => {
    // 起伏のある輪郭。厳しく取れば起伏をなぞり、緩めれば 1 つの円へ畳まれる。
    // 本数は smoothJoints の後だと継ぎ目の平行具合で揺れるので、当てはめ側で測る
    const rippled = new Uint8Array(256 * 256).fill(255)
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const dx = x + 0.5 - 128
        const dy = y + 0.5 - 128
        const wobble = 90 + Math.sin(Math.atan2(dy, dx) * 9) * 7
        if (Math.hypot(dx, dy) < wobble) rippled[y * 256 + x] = 0
      }
    }
    const arcsAt = (tolerance: number) => {
      const points = fitToModule(
        contoursFromRaster(rippled, 256).map((c) => c.points),
        5,
      )[0]
      return traceArcs(points, { toleranceRatio: tolerance, snapRadii: false }).segments.length
    }
    const tight = arcsAt(0.002)
    expect(tight).toBeGreaterThan(12)
    expect(arcsAt(0.06)).toBeLessThan(tight / 2)
  })
})

describe('PNG を読む', () => {
  it('焼いたものをそのまま読み戻せる', () => {
    const gray = canvas(64, disc(32, 32, 20))
    const decoded = decodeGray(encodeGrayPng(gray, 64))
    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(64)
    expect(fidelity(gray, decoded.gray)).toBe(1)
  })

  it('PNG でなければ落ちる', () => {
    expect(() => decodeGray(Buffer.from('not a png'))).toThrow()
  })
})

describe('生成画像で踏んだこと', () => {
  it('小さいが意味のある白を捨てない', () => {
    // 0.2% で切っていたら、ゴリラの眉間の皺（0.1%）と口角（0.04%）が消えた。
    // 本物のゴミは 1 画素程度なので、桁を下げても分けられる
    const S = 512
    const g = canvas(S, (x, y) => {
      if (!disc(256, 256, 200)(x, y)) return false
      // 面積比 0.05% ほどの細い白の切れ込み
      if (y >= 250 && y <= 254 && x >= 200 && x <= 300) return false
      return true
    })
    g[10 * S + 10] = 0 // 1 画素のゴミ
    const cs = contoursFromRaster(g, S)
    expect(cs).toHaveLength(2) // 外周と切れ込み。ゴミは落ちる
    expect(cs.filter((c) => !c.solid)).toHaveLength(1)
  })

  it('1 輪郭 64 セグメントの上限で設計ごと落ちない', () => {
    // 生成した歩くゴリラの外周は、筋の切れ込みを含むので誤差 0.006 で 64 を超えた。
    // 超えた輪郭だけ緩めて収める（他の部品を巻き添えにしない）
    const S = 512
    const jagged = canvas(S, (x, y) => {
      const dx = x + 0.5 - 256
      const dy = y + 0.5 - 256
      const r = 180 + Math.sin(Math.atan2(dy, dx) * 40) * 12
      return Math.hypot(dx, dy) < r
    })
    const d = buildFromContours(contoursFromRaster(jagged, S), { tolerance: 0.001 })
    expect(() => designSchema.parse(d)).not.toThrow()
    const c = d.shapes[0]
    if (c.kind !== 'contour') throw new Error('輪郭が無い')
    expect(c.segments.length).toBeLessThanOrEqual(64)
  })

  it('対になる輪郭は鏡像で作る', () => {
    // 生成画像は素でわずかに非対称。別々に当てると左右の目が違う形になる
    const S = 512
    const g = canvas(S, (x, y) => {
      if (!disc(256, 256, 200)(x, y)) return false
      // 左右の目。右をわずかに大きく描いておく
      if (disc(190, 220, 30)(x, y)) return false
      if (disc(322, 220, 33)(x, y)) return false
      return true
    })
    const d = buildFromContours(contoursFromRaster(g, S), { tolerance: 0.006 })
    const eyes = d.shapes.filter((s) => s.kind === 'contour' && s.id !== 'r0')
    expect(eyes).toHaveLength(2)
    if (eyes[0].kind !== 'contour' || eyes[1].kind !== 'contour') throw new Error()
    // 鏡像なら本数が揃い、半径の集合も一致する
    expect(eyes[0].segments.length).toBe(eyes[1].segments.length)
    const radii = (s: typeof eyes[0]) =>
      s.kind === 'contour' ? s.segments.map((g) => g.r ?? 0).sort((a, b) => a - b) : []
    expect(radii(eyes[0])).toEqual(radii(eyes[1]))
  })
})

describe('対称の強制', () => {
  // 生成画像は画素ではほぼ対称なのに、輪郭のつながり方が左右で違うことがある。
  // 輪郭を取り出してから直そうとしても位相が違うので無理。マスクを画素で対称化する
  it('片側だけの橋があるマスクを、位相ごと対称にする', () => {
    const S = 256
    const g = canvas(S, (x, y) => {
      if (!disc(128, 128, 100)(x, y)) return false
      // 左右の目（白）
      if (disc(96, 110, 18)(x, y) || disc(160, 110, 18)(x, y)) return false
      // 右の目にだけ、外へ抜ける 2 画素の白い橋 ← 位相の非対称
      if (y >= 109 && y <= 110 && x >= 160 && x <= 230) return false
      return true
    })
    const mask = new Uint8Array(S * S)
    for (let i = 0; i < mask.length; i++) mask[i] = g[i] < 128 ? 1 : 0
    const sym = symmetrizeMask(mask, S, S)
    expect(sym.axis).not.toBeNull()
    // 完全に対称になっている
    let mismatch = 0
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const mx = Math.round(2 * (sym.axis as number) - 1 - x)
        if (mx >= 0 && mx < S && sym.ink[y * S + x] !== sym.ink[y * S + mx]) mismatch++
      }
    }
    expect(mismatch).toBe(0)
  })

  it('非対称なマスクには手を出さない', () => {
    const S = 128
    // 右へ大きく寄った塊
    const g = canvas(S, (x, y) => disc(90, 64, 30)(x, y) || (x > 40 && x < 60 && y > 30 && y < 40))
    const mask = new Uint8Array(S * S)
    for (let i = 0; i < mask.length; i++) mask[i] = g[i] < 128 ? 1 : 0
    const sym = symmetrizeMask(mask, S, S)
    expect(sym.axis).toBeNull()
    expect(sym.ink).toBe(mask)
  })

  it('復元した設計が実際に対称になる', () => {
    const S = 256
    const g = canvas(S, (x, y) => {
      if (!disc(128, 128, 100)(x, y)) return false
      if (disc(96, 110, 18)(x, y) || disc(160, 110, 18)(x, y)) return false
      if (y >= 109 && y <= 110 && x >= 160 && x <= 230) return false
      return true
    })
    const d = buildFromContours(contoursFromRaster(g, S), { tolerance: 0.006 })
    const built = build(designSchema.parse(d))
    // 画素の鏡像一致（metrics の mirror と同じ見方）
    const r = rasterizeGray(built, { size: 256 })
    let same = 0
    let n = 0
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 128; x++) {
        n++
        if (r.gray[y * 256 + x] < 128 === r.gray[y * 256 + 255 - x] < 128) same++
      }
    }
    expect(same / n).toBeGreaterThan(0.99)
  })
})
