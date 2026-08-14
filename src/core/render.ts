import type { BuildResult, Bounds } from './build'
import type { LogoDesign } from './dsl'
import { gridStep } from './units'

export type RenderOptions = {
  /** 余白（px）。既定は短辺の 8% */
  padding?: number
  /** 設計図に寸法ラベルを描くか */
  annotate?: boolean
  /** 背景を塗るか（false なら透明） */
  background?: boolean
}

function pad(bounds: Bounds, padding: number): Bounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  }
}

function viewBox(b: Bounds): string {
  return `${round(b.x)} ${round(b.y)} ${round(b.width)} ${round(b.height)}`
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function defaultPadding(b: Bounds): number {
  return Math.max(Math.min(b.width, b.height) * 0.08, 8)
}

/** ④-a 完成ロゴ SVG */
export function renderLogo(
  design: LogoDesign,
  built: BuildResult,
  options: RenderOptions = {},
): string {
  const raw = built.artBounds
  const padding = options.padding ?? defaultPadding(raw)
  const box = pad(raw, padding)

  const bg = options.background
    ? `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" fill="${color(design.palette.background)}"/>`
    : ''

  const paths = built.parts
    .map(
      (p) =>
        `<path d="${escapeAttr(p.pathData)}" fill="${color(p.fill)}" fill-rule="evenodd" data-part="${escapeAttr(p.id)}"/>`,
    )
    .join('\n    ')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(box)}" role="img" aria-label="${escapeAttr(design.name)}">
  <title>${escapeText(design.name)}</title>
  ${bg}
  <g>
    ${paths}
  </g>
</svg>`
}

/** ④-b 設計図 SVG — 完成ロゴとまったく同じデータから描く */
export function renderBlueprint(
  design: LogoDesign,
  built: BuildResult,
  options: RenderOptions = {},
): string {
  const padding = options.padding ?? defaultPadding(built.bounds)
  const box = pad(built.bounds, padding)
  const M = design.module
  const annotate = options.annotate ?? true

  const ink = '#1F3A5F'
  const guide = '#9BB4CE'
  const grid = '#DDE6EE'

  const hair = Math.max(round(Math.min(box.width, box.height) / 900), 0.4)

  const gridLines = buildGrid(box, gridStep(design.grid) * M, grid, hair)
  const goldenGuides = buildGoldenGuides(box, built.artBounds, M, hair)

  const shapes = built.construction
    .map((c) => {
      switch (c.kind) {
        case 'circle':
          return `<circle cx="${round(c.cx)}" cy="${round(c.cy)}" r="${round(c.r)}" fill="none" stroke="${guide}" stroke-width="${hair * 2}"/>`
        case 'line': {
          // 作図線は少しだけ延長して「補助線」らしく見せる
          const dx = c.x2 - c.x1
          const dy = c.y2 - c.y1
          const len = Math.hypot(dx, dy) || 1
          const ex = (dx / len) * M * 0.35
          const ey = (dy / len) * M * 0.35
          return `<line x1="${round(c.x1 - ex)}" y1="${round(c.y1 - ey)}" x2="${round(c.x2 + ex)}" y2="${round(c.y2 + ey)}" stroke="${guide}" stroke-width="${hair * 2}" stroke-dasharray="${round(M * 0.12)} ${round(M * 0.08)}"/>`
        }
        case 'rect':
          return `<rect x="${round(c.cx - c.w / 2)}" y="${round(c.cy - c.h / 2)}" width="${round(c.w)}" height="${round(c.h)}" fill="none" stroke="${guide}" stroke-width="${hair * 2}" transform="rotate(${round(c.rotate)} ${round(c.cx)} ${round(c.cy)})"/>`
        case 'point': {
          const t = M * 0.09
          return `<g stroke="${ink}" stroke-width="${hair * 2}"><line x1="${round(c.x - t)}" y1="${round(c.y)}" x2="${round(c.x + t)}" y2="${round(c.y)}"/><line x1="${round(c.x)}" y1="${round(c.y - t)}" x2="${round(c.x)}" y2="${round(c.y + t)}"/></g>`
        }
      }
    })
    .join('\n    ')

  const silhouette = built.parts
    .map(
      (p) =>
        `<path d="${escapeAttr(p.pathData)}" fill="${ink}" fill-opacity="0.14" fill-rule="evenodd"/>`,
    )
    .join('\n    ')

  const outline = built.parts
    .map(
      (p) =>
        `<path d="${escapeAttr(p.pathData)}" fill="none" stroke="${ink}" stroke-width="${hair * 3}" fill-rule="evenodd"/>`,
    )
    .join('\n    ')

  const labels = annotate ? buildLabels(design, ink, M, hair) : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(box)}" role="img" aria-label="${escapeAttr(design.name)} の設計図">
  <title>${escapeText(design.name)} — construction</title>
  <rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" fill="#FBFDFF"/>
  <g data-layer="grid">
    ${gridLines}
  </g>
  <g data-layer="proportion">
    ${goldenGuides}
  </g>
  <g data-layer="silhouette">
    ${silhouette}
  </g>
  <g data-layer="construction">
    ${shapes}
  </g>
  <g data-layer="outline">
    ${outline}
  </g>
  <g data-layer="labels" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${round(M * 0.16)}" fill="${ink}">
    ${labels}
  </g>
</svg>`
}

function buildGrid(box: Bounds, step: number, color: string, hair: number): string {
  if (step <= 0) return ''
  const lines: string[] = []
  const start = Math.floor(box.x / step) * step
  const end = box.x + box.width
  for (let x = start; x <= end; x += step) {
    const major = Math.abs(x) < 1e-6
    lines.push(
      `<line x1="${round(x)}" y1="${round(box.y)}" x2="${round(x)}" y2="${round(box.y + box.height)}" stroke="${major ? '#B9CBDC' : color}" stroke-width="${hair * (major ? 2 : 1)}"/>`,
    )
  }
  const startY = Math.floor(box.y / step) * step
  const endY = box.y + box.height
  for (let y = startY; y <= endY; y += step) {
    const major = Math.abs(y) < 1e-6
    lines.push(
      `<line x1="${round(box.x)}" y1="${round(y)}" x2="${round(box.x + box.width)}" y2="${round(y)}" stroke="${major ? '#B9CBDC' : color}" stroke-width="${hair * (major ? 2 : 1)}"/>`,
    )
  }
  return lines.join('\n    ')
}

/**
 * 比例の作図を重ねる。
 *
 * 設計図の役目は「どの比で決めたか」を見せることなので、実際に使っている
 * 比例系そのものを描く:
 *   - 原点からの φ 冪の同心円 … 半径の候補集合（units.ts）を可視化したもの
 *   - 完成形の外接矩形と、その黄金分割線 … 全体の比を確認するための線
 */
function buildGoldenGuides(box: Bounds, art: Bounds, M: number, hair: number): string {
  const tone = '#C9B896' // 比例の線だけ暖色にして、作図線（寒色）と区別する
  const out: string[] = []

  // 原点からの φ 冪の同心円
  const maxR = Math.max(
    Math.hypot(box.x, box.y),
    Math.hypot(box.x + box.width, box.y + box.height),
  )
  for (let n = -2; n <= 6; n++) {
    const r = Math.pow(PHI, n) * M
    if (r < M * 0.2 || r > maxR) continue
    out.push(
      `<circle cx="0" cy="0" r="${round(r)}" fill="none" stroke="${tone}" stroke-width="${hair}" stroke-opacity="0.55" stroke-dasharray="${round(M * 0.05)} ${round(M * 0.07)}"/>`,
    )
  }

  if (art.width <= 0 || art.height <= 0) return out.join('\n    ')

  // 完成形の外接矩形
  out.push(
    `<rect x="${round(art.x)}" y="${round(art.y)}" width="${round(art.width)}" height="${round(art.height)}" fill="none" stroke="${tone}" stroke-width="${hair * 1.2}" stroke-opacity="0.8"/>`,
  )

  // その黄金分割線（左右・上下から 1/φ の位置）
  const dx = art.width / PHI
  const dy = art.height / PHI
  for (const x of [art.x + dx, art.x + art.width - dx]) {
    out.push(
      `<line x1="${round(x)}" y1="${round(art.y)}" x2="${round(x)}" y2="${round(art.y + art.height)}" stroke="${tone}" stroke-width="${hair}" stroke-opacity="0.7" stroke-dasharray="${round(M * 0.14)} ${round(M * 0.05)} ${round(M * 0.03)} ${round(M * 0.05)}"/>`,
    )
  }
  for (const y of [art.y + dy, art.y + art.height - dy]) {
    out.push(
      `<line x1="${round(art.x)}" y1="${round(y)}" x2="${round(art.x + art.width)}" y2="${round(y)}" stroke="${tone}" stroke-width="${hair}" stroke-opacity="0.7" stroke-dasharray="${round(M * 0.14)} ${round(M * 0.05)} ${round(M * 0.03)} ${round(M * 0.05)}"/>`,
    )
  }

  // 全体の縦横比。φ / √2 / 1:1 に近ければ、その名前を出す
  const ratio = art.width / art.height
  out.push(
    `<text x="${round(art.x)}" y="${round(art.y - M * 0.12)}" fill="#8A7A5C" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${round(M * 0.15)}">${escapeText(describeRatio(ratio))}</text>`,
  )

  return out.join('\n    ')
}

/** 縦横比を、設計で使われる比の名前に照らして説明する */
function describeRatio(ratio: number): string {
  const named: Array<[number, string]> = [
    [1, '1:1'],
    [PHI, '1:φ'],
    [1 / PHI, 'φ:1'],
    [Math.SQRT2, '1:√2'],
    [1 / Math.SQRT2, '√2:1'],
    [Math.sqrt(3), '1:√3'],
    [2, '1:2'],
    [0.5, '2:1'],
    [3 / 2, '2:3'],
  ]
  for (const [value, label] of named) {
    if (Math.abs(ratio - value) / value < 0.03) return `${label} (${ratio.toFixed(3)})`
  }
  return `${ratio.toFixed(3)} : 1`
}

/** 円の半径に寸法線とモジュール表記を添える */
function buildLabels(design: LogoDesign, ink: string, M: number, hair: number): string {
  const out: string[] = []
  for (const s of design.shapes) {
    if (s.kind !== 'circle' && s.kind !== 'ring') continue
    const cx = s.cx * M
    const cy = s.cy * M
    const r = s.r * M
    // 半径線は右上 45°
    const k = Math.SQRT1_2
    const ex = cx + r * k
    const ey = cy - r * k
    out.push(
      `<line x1="${round(cx)}" y1="${round(cy)}" x2="${round(ex)}" y2="${round(ey)}" stroke="${ink}" stroke-width="${hair * 1.5}" stroke-dasharray="${round(M * 0.06)} ${round(M * 0.06)}"/>`,
    )
    out.push(
      `<text x="${round(cx + (r * k) / 2 + M * 0.06)}" y="${round(cy - (r * k) / 2 - M * 0.06)}" fill="${ink}" fill-opacity="0.75">${formatModule(s.r)}</text>`,
    )
  }
  return out.join('\n    ')
}

const PHI = (1 + Math.sqrt(5)) / 2

function formatModule(v: number): string {
  for (let n = -3; n <= 5; n++) {
    if (Math.abs(v - Math.pow(PHI, n)) < 1e-6) {
      return n === 0 ? '1M' : n === 1 ? 'φM' : `φ^${n}M`
    }
  }
  const rounded = Math.round(v * 100) / 100
  return `${rounded}M`
}

// --- 多層防御 ---
// dsl.ts のスキーマが不正な色や id を弾く（第一層）が、レンダラ単体でも
// markup を抜け出せないようにしておく。compile() を通さず render を直接呼ぶ
// 経路が将来増えても安全側に倒れる。

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** 色として使える形だけ通し、それ以外は黒へ落とす（属性を抜け出させない） */
function color(value: string): string {
  return HEX_COLOR.test(value) ? value : '#000000'
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
