import { deflateSync, inflateSync } from 'node:zlib'
import type { BuildResult } from './build'
import { rasterizeGray, type RasterOptions } from './raster'

/**
 * PNG を読み書きする。
 *
 * zlib が要るので node 専用。**ブラウザで走る側（raster.ts / metrics.ts）から
 * import してはいけない**——Pages 向けのビルドが落ちる。画像モデルとの
 * やり取りと、道具の出力にだけ使う。
 *
 * 読む側の対応は「画像モデルが実際に返す形」に絞る——8bit / 非インターレース /
 * グレー・パレット・RGB・RGBA。16bit は上位バイトだけ見る。
 */

export type DecodedImage = {
  /** 明度 0〜255。透明な画素は紙（255）として扱う */
  gray: Uint8Array
  width: number
  height: number
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 1 画素あたりのチャンネル数 */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * 走査線ごとのフィルタを戻す。
 *
 * PNG は行ごとに 5 種の予測から 1 つを選んで差分を格納する。ここを外すと
 * 画像が縞になるだけで例外にはならないので、間違いに気づきにくい。
 */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prior ? prior[i] : 0
      const c = prior && i >= bpp ? prior[i - bpp] : 0
      let value = line[i]
      switch (filter) {
        case 0:
          break
        case 1:
          value += a
          break
        case 2:
          value += b
          break
        case 3:
          value += (a + b) >> 1
          break
        case 4: {
          // Paeth。3 つの予測のうち、線形推定に最も近いものを採る
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
        default:
          throw new Error(`PNG: 未知のフィルタ ${filter}`)
      }
      cur[i] = value & 0xff
    }
  }
  return out
}

/** PNG を読み、明度の配列にする。 */
export function decodeGray(buffer: Buffer): DecodedImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error('PNG ではありません')
  }

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette: Buffer | null = null
  let paletteAlpha: Buffer | null = null
  const idat: Buffer[] = []

  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    pos += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') paletteAlpha = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
  }

  if (width <= 0 || height <= 0) throw new Error('PNG: 大きさが読めません')
  if (interlace !== 0) throw new Error('PNG: インターレースには未対応です')
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`PNG: ビット深度 ${bitDepth} には未対応です（8 か 16 のみ）`)
  }
  const channels = CHANNELS[colorType]
  if (channels === undefined) throw new Error(`PNG: 未知の色型 ${colorType}`)

  const bytes = bitDepth === 16 ? 2 : 1
  const bpp = channels * bytes
  const pixels = unfilter(inflateSync(Buffer.concat(idat)), width, height, bpp)

  const gray = new Uint8Array(width * height)
  // 16bit は上位バイトだけ見る。閾値で二値化するので下位は効かない
  const sample = (i: number) => pixels[i * bytes]

  for (let i = 0; i < width * height; i++) {
    const base = i * channels
    let r: number
    let g: number
    let b: number
    let alpha = 255

    if (colorType === 3) {
      const index = pixels[i * bpp]
      if (!palette) throw new Error('PNG: パレットがありません')
      r = palette[index * 3]
      g = palette[index * 3 + 1]
      b = palette[index * 3 + 2]
      if (paletteAlpha && index < paletteAlpha.length) alpha = paletteAlpha[index]
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = sample(base)
      if (colorType === 4) alpha = sample(base + 1)
    } else {
      r = sample(base)
      g = sample(base + 1)
      b = sample(base + 2)
      if (colorType === 6) alpha = sample(base + 3)
    }

    // 透明は紙。背景を抜いた画像がそのまま通るように
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    gray[i] = alpha < 128 ? 255 : Math.round(luma)
  }

  return { gray, width, height }
}

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

/**
 * ビルド結果を正方形の PNG にする。見るための絵なので、既定で縁を均す。
 */
export function rasterize(built: BuildResult, options: RasterOptions = {}): Buffer {
  const { gray, size } = rasterizeGray(built, { samples: 3, ...options })
  return encodeGrayPng(gray, size)
}
