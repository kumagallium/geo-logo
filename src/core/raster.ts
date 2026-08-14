import { deflateSync } from 'node:zlib'
import type { BuildResult } from './build'
import { getPaper, resetProject } from './paper-setup'

/**
 * 完成形を PNG へ焼く。
 *
 * 視覚モデルに自分の出力を見せるために要る。これまでモデルは一度も自分の
 * 描いたものを見ていなかった。デザイナーは引いては見て直すが、その輪が
 * 閉じていない。
 *
 * SVG のラスタライザを依存に足すのは避け、paper の内外判定で画素を塗る。
 * ブラウザも不要で、テストからも呼べる。
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** グレースケール 8bit の PNG を組み立てる */
function encodePng(gray: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale

  // 各行の先頭にフィルタ種別バイト（0 = None）が要る
  const raw = Buffer.alloc(size * (size + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0
    Buffer.from(gray.subarray(y * size, (y + 1) * size)).copy(raw, y * (size + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export type RasterOptions = {
  /** 一辺の画素数 */
  size?: number
  /** 余白（マークの短辺に対する比） */
  margin?: number
}

/**
 * ビルド結果を正方形の PNG にする。マークは中央へ、縦横比を保って収める。
 */
export function rasterize(built: BuildResult, options: RasterOptions = {}): Buffer {
  const size = Math.max(32, Math.min(options.size ?? 320, 1024))
  const margin = options.margin ?? 0.08

  const gray = new Uint8Array(size * size).fill(255)
  const art = built.artBounds
  if (art.width <= 0 || art.height <= 0 || built.parts.length === 0) {
    return encodePng(gray, size)
  }

  const p = getPaper()
  resetProject()
  try {
    const shape = new p.CompoundPath(built.parts.map((x) => x.pathData).join(' '))

    // マークの短辺ではなく長辺に合わせる。はみ出させない
    const span = Math.max(art.width, art.height) * (1 + margin * 2)
    const cx = art.x + art.width / 2
    const cy = art.y + art.height / 2
    const step = span / size
    const x0 = cx - span / 2 + step / 2
    const y0 = cy - span / 2 + step / 2

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const pt = new p.Point(x0 + px * step, y0 + py * step)
        if (shape.contains(pt)) gray[py * size + px] = 17
      }
    }
    shape.remove()
  } finally {
    resetProject()
  }

  return encodePng(gray, size)
}
