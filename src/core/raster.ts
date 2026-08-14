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
export function encodeGrayPng(gray: Uint8Array, width: number, height = width): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale

  // 各行の先頭にフィルタ種別バイト（0 = None）が要る
  const raw = Buffer.alloc(height * (width + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
    Buffer.from(gray.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1)
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
 * ビルド結果を正方形の画素にする。マークは中央へ、縦横比を保って収める。
 *
 * PNG に包む前で切ってあるのは、複数案を 1 枚のシートへ並べるため。
 */
export function rasterizeGray(
  built: BuildResult,
  options: RasterOptions = {},
): { gray: Uint8Array; size: number } {
  const size = Math.max(32, Math.min(options.size ?? 320, 1024))
  const margin = options.margin ?? 0.08

  const gray = new Uint8Array(size * size).fill(255)
  const art = built.artBounds
  if (art.width <= 0 || art.height <= 0 || built.parts.length === 0) {
    return { gray, size }
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

  return { gray, size }
}

/**
 * ビルド結果を正方形の PNG にする。
 */
export function rasterize(built: BuildResult, options: RasterOptions = {}): Buffer {
  const { gray, size } = rasterizeGray(built, options)
  return encodeGrayPng(gray, size)
}
