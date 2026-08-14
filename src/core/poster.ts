import type { LogoDesign } from './dsl'

/**
 * 作図シート（ポスター）。
 *
 * 完成ロゴと設計図を裸の SVG で出していたが、同じ中身でも 1 枚の紙面として
 * 構成されているかどうかで受ける印象がまるで違う。作図の密度・比例の根拠・
 * 設計意図がひと目で並ぶことに、この道具の値打ちがある。
 *
 * 紙面は √2（A 判）の縦。設計で silver 比を扱う道具なので、紙も同じ比に揃える。
 */

const W = 1000
const H = Math.round(W * Math.SQRT2) // 1414

const MARGIN = 76
const FRAME_INSET = 38

/** 紙・墨・罫。ロゴ自体の palette とは別に、紙面の色として持つ。 */
const PAPER = '#F4F1E8'
/** 方眼。作図面の地として敷く */
const GRAPH = '#DED8C6'
const GRAPH_BOLD = '#D2CAB2'
const INK = '#1B1B1A'
const RULE = '#B9B2A0'
const SUBTLE = '#6F6A5E'

// フォント名の引用符は単引用符にすること。属性値を二重引用符で囲むので、
// 中に二重引用符が入ると属性が閉じて XML が壊れる。
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const SANS = "system-ui, -apple-system, 'Helvetica Neue', sans-serif"

export type PosterOptions = {
  /** 見出しに出す作り手や道具の名前 */
  wordmark?: string
}

/**
 * 全角を 1、半角を 0.5 として数えた表示幅。
 *
 * SVG には自動折り返しが無いので自前で折る。等幅フォント前提なら
 * この近似で十分に揃う。
 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[\x20-\x7e]/.test(ch) ? 0.5 : 1
  return w
}

/** 行頭に来てほしくない文字（最小限の禁則処理） */
const NO_LINE_START = new Set('、。，．）］｝」』〉》・！？：；ー々ゝゞ,.)]}!?:;')

/**
 * 表示幅で折り返す。日本語は任意の位置で、英字は単語の切れ目で折る。
 */
export function wrapText(text: string, maxWidth: number, maxLines = 14): string[] {
  const lines: string[] = []
  let line = ''

  const flush = () => {
    if (line) lines.push(line)
    line = ''
  }

  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    if (ch === '\n') {
      flush()
      continue
    }
    if (displayWidth(line + ch) > maxWidth) {
      // 英単語の途中なら直前の空白まで戻す
      const ascii = /[A-Za-z0-9]/.test(ch)
      const cut = ascii ? line.lastIndexOf(' ') : -1
      if (cut > maxWidth * 0.4) {
        lines.push(line.slice(0, cut))
        line = line.slice(cut + 1)
      } else {
        flush()
      }
    }
    line += ch
    if (lines.length >= maxLines) break
  }
  flush()

  // 行頭に句読点や閉じ括弧が来たら前の行へ送る
  for (let i = 1; i < lines.length; i++) {
    while (lines[i] && NO_LINE_START.has(lines[i][0])) {
      lines[i - 1] += lines[i][0]
      lines[i] = lines[i].slice(1)
    }
  }

  const kept = lines.filter((l) => l.length > 0).slice(0, maxLines)
  if (kept.length === maxLines && displayWidth(text) > maxWidth * maxLines) {
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, -1)}…`
  }
  return kept
}

/**
 * 生成済みの SVG を紙面へ配置する。
 *
 * SVG は入れ子にできるので、内側の viewBox がそのまま縮尺として効く。
 * 文字列を組み直さずに済み、完成ロゴ・設計図と紙面上の図が同じデータである
 * ことも保たれる。
 */
function place(svg: string, x: number, y: number, w: number, h: number): string {
  // 内側の SVG は自前の width/height を持つ（`<img>` で引き伸ばされないため）。
  // 紙面へ置くときは配置側の寸法が効くよう、先に落としてから付け直す
  return svg
    .replace(/^(<svg[^>]*?)\s+width="[^"]*"\s+height="[^"]*"/, '$1')
    .replace(
      /^<svg /,
      `<svg x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" `,
    )
}

/**
 * 方眼紙。
 *
 * 設計図側の方眼は外してある（画面用の青い方眼はクリーム色の紙から浮く）。
 * 紙の地としての方眼はまた別で、作図の背後にあると図面らしさが出る。
 * 5 目盛ごとに濃くするのは方眼紙の慣習。
 */
function graphPaper(x: number, y: number, w: number, h: number, step: number): string {
  const lines: string[] = []
  for (let i = 0, gx = x; gx <= x + w + 0.01; i++, gx = x + i * step) {
    const bold = i % 5 === 0
    lines.push(
      `<line x1="${gx.toFixed(1)}" y1="${y}" x2="${gx.toFixed(1)}" y2="${y + h}" stroke="${bold ? GRAPH_BOLD : GRAPH}" stroke-width="${bold ? 0.6 : 0.35}"/>`,
    )
  }
  for (let i = 0, gy = y; gy <= y + h + 0.01; i++, gy = y + i * step) {
    const bold = i % 5 === 0
    lines.push(
      `<line x1="${x}" y1="${gy.toFixed(1)}" x2="${x + w}" y2="${gy.toFixed(1)}" stroke="${bold ? GRAPH_BOLD : GRAPH}" stroke-width="${bold ? 0.6 : 0.35}"/>`,
    )
  }
  return lines.join('\n    ')
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 紙面へ出す文字列の長さを切る（巨大文字列でのメモリ圧迫を防ぐ） */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

export function renderPoster(
  design: LogoDesign,
  logoSvg: string,
  blueprintSvg: string,
  options: PosterOptions = {},
): string {
  const wordmark = clip(options.wordmark ?? 'geo-logo', 40)
  const name = clip(design.name, 60)
  const concept = clip(design.concept, 600)

  const inner = { x: FRAME_INSET, y: FRAME_INSET, w: W - FRAME_INSET * 2, h: H - FRAME_INSET * 2 }

  // 見出し
  const headY = MARGIN + 26

  // 作図面。紙面の大半をここに使う
  const drawY = MARGIN + 74
  const drawH = 880
  const drawW = W - MARGIN * 2

  // 下段。左に設計意図、右に完成マーク
  const footY = drawY + drawH + 64
  const markBox = 190
  const textW = W - MARGIN * 2 - markBox - 48

  // 等幅で 1 文字 ≒ 0.6em。表示幅（全角 1・半角 0.5）に直して割る
  const bodySize = 15
  const maxWidth = textW / (bodySize * 1.02)
  const lines = wrapText(concept, maxWidth, 12)

  const conceptLines = lines
    .map(
      (l, i) =>
        `<text x="${MARGIN}" y="${footY + 44 + i * (bodySize * 1.85)}" font-family="${SANS}" font-size="${bodySize}" fill="${INK}">${escapeText(l)}</text>`,
    )
    .join('\n    ')

  const markX = W - MARGIN - markBox

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeText(name)} の作図シート">
  <title>${escapeText(name)} — construction sheet</title>
  <rect width="${W}" height="${H}" fill="${PAPER}"/>
  <rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" fill="none" stroke="${RULE}" stroke-width="1"/>

  <g data-layer="head">
    ${place(logoSvg, MARGIN, headY - 26, 30, 30)}
    <text x="${MARGIN + 42}" y="${headY}" font-family="${SANS}" font-size="20" font-weight="600" fill="${INK}">${escapeText(wordmark)}</text>
    <text x="${W - MARGIN}" y="${headY}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${SUBTLE}" letter-spacing="1.5">CONSTRUCTION</text>
    <line x1="${MARGIN}" y1="${headY + 22}" x2="${W - MARGIN}" y2="${headY + 22}" stroke="${RULE}" stroke-width="1"/>
  </g>

  <g data-layer="graph">
    ${graphPaper(MARGIN, drawY, drawW, drawH, 8)}
  </g>

  <g data-layer="drawing">
    ${place(blueprintSvg, MARGIN, drawY, drawW, drawH)}
  </g>

  <g data-layer="foot">
    <line x1="${MARGIN}" y1="${footY - 26}" x2="${W - MARGIN}" y2="${footY - 26}" stroke="${RULE}" stroke-width="1"/>
    <text x="${MARGIN}" y="${footY}" font-family="${MONO}" font-size="12" fill="${SUBTLE}" letter-spacing="1.5">CONCEPT</text>
    ${conceptLines}

    <rect x="${markX}" y="${footY - 18}" width="${markBox}" height="${markBox}" fill="none" stroke="${RULE}" stroke-width="1"/>
    ${place(logoSvg, markX + 24, footY + 6, markBox - 48, markBox - 48)}
    <text x="${markX + markBox / 2}" y="${footY + markBox + 20}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${SUBTLE}">${escapeText(clip(name, 28))}</text>
  </g>
</svg>`
}
