/**
 * アプリアイコンの元画像を生成する。
 *
 *   node scripts/make-icon.mjs && pnpm tauri icon src-tauri/app-icon.png
 *
 * SVG をラスタライズする依存を足したくないので、円のブーリアン演算を
 * ピクセルごとに判定して直接 PNG を書く。このアプリの題材そのもので、
 * 外部ツールなしに再生成できる。
 *
 * 形は bitten アーキタイプ（円板から円を食い込ませた三日月）＋ 軌道の点。
 * 32px でも輪郭が読める構成を選んだ。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const SIZE = 1024
const SS = 3 // スーパーサンプリング（3x3）でアンチエイリアスする

// 前景色。設計図の線と揃えた濃紺
const FG = [17, 24, 39]

/** 中心 (cx,cy) 半径 r の円の内側か */
const inside = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r

/**
 * マークの内外判定。座標は -1〜1 に正規化した空間。
 * 大きな円板から、右上へずらした円を抜き、離れた小円を足す。
 */
function isInk(x, y) {
  const disc = inside(x, y, -0.08, 0, 0.78)
  const bite = inside(x, y, 0.42, -0.34, 0.62)
  const dot = inside(x, y, 0.52, 0.5, 0.17)
  return (disc && !bite) || dot
}

const pixels = Buffer.alloc(SIZE * SIZE * 4)
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let hits = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = ((px + (sx + 0.5) / SS) / SIZE) * 2 - 1
        const y = ((py + (sy + 0.5) / SS) / SIZE) * 2 - 1
        if (isInk(x, y)) hits++
      }
    }
    const a = Math.round((hits / (SS * SS)) * 255)
    const o = (py * SIZE + px) * 4
    pixels[o] = FG[0]
    pixels[o + 1] = FG[1]
    pixels[o + 2] = FG[2]
    pixels[o + 3] = a
  }
}

// --- PNG エンコード（RGBA / フィルタなし） ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
// 10..12 は compression / filter / interlace すべて 0

// 各行の先頭にフィルタ種別バイト（0 = None）が要る
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync('src-tauri', { recursive: true })
writeFileSync('src-tauri/app-icon.png', png)
console.log(`[make-icon] src-tauri/app-icon.png (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`)
