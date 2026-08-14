/**
 * Node.js ランタイムを取得して src-tauri/sidecar/ と src-tauri/binaries/ に配置する。
 *
 * 配布版アプリでは Node 自体を同梱しないと動かない:
 *   - macOS: Finder / launchd 経由の起動は PATH を継承せず、Homebrew や nvm の
 *     node が見えない
 *   - Windows: そもそも node が入っていない環境を想定する
 *
 * 2 箇所に置く:
 *   1. src-tauri/sidecar/node[.exe]          … Resources に同梱し、Rust から直接 spawn する
 *   2. src-tauri/binaries/geo-logo-server-<triple>[.exe]
 *      … Tauri の sidecar 命名規約に合わせたコピー。externalBin の解決に要る
 *
 * Graphium の scripts/fetch-node.mjs を移植。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

// Node 22 LTS (Jod) — 2027-04 まで active LTS
const NODE_VERSION = 'v22.12.0'
const SIDECAR_DIR = join(PROJECT_ROOT, 'src-tauri', 'sidecar')
const BINARIES_DIR = join(PROJECT_ROOT, 'src-tauri', 'binaries')
const SIDECAR_NAME = 'geo-logo-server'

const force = process.argv.includes('--force')

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
if (!isWindows && !isMac) {
  console.error(`[fetch-node] 未対応のプラットフォーム: ${process.platform}（対応: darwin, win32）`)
  process.exit(1)
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

/** Tauri の sidecar 命名規則に合わせた host target triple */
function hostTargetTriple() {
  if (isMac) return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  // Windows は MSVC ABI 固定（Tauri 既定）
  return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
}

const exe = isWindows ? '.exe' : ''
const sidecarNode = join(SIDECAR_DIR, `node${exe}`)
const binaryNode = join(BINARIES_DIR, `${SIDECAR_NAME}-${hostTargetTriple()}${exe}`)

if (!force && existsSync(sidecarNode) && existsSync(binaryNode)) {
  console.log('[fetch-node] 配置済み。--force で再取得します')
  process.exit(0)
}

mkdirSync(SIDECAR_DIR, { recursive: true })
mkdirSync(BINARIES_DIR, { recursive: true })

const platform = isWindows ? 'win' : 'darwin'
const dist = `node-${NODE_VERSION}-${platform}-${arch}`
const ext = isWindows ? 'zip' : 'tar.gz'
const url = `https://nodejs.org/dist/${NODE_VERSION}/${dist}.${ext}`
const work = join(SIDECAR_DIR, '.download')

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

console.log(`[fetch-node] 取得: ${url}`)
const archive = join(work, `node.${ext}`)

// curl と tar は macOS / Windows 10+ に標準で入っている。依存を増やさない。
const dl = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', archive, url], { stdio: 'inherit' })
if (dl.status !== 0) {
  console.error('[fetch-node] ダウンロードに失敗しました')
  process.exit(1)
}

const extract = spawnSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' })
if (extract.status !== 0) {
  console.error('[fetch-node] 展開に失敗しました')
  process.exit(1)
}

const extracted = isWindows
  ? join(work, dist, 'node.exe')
  : join(work, dist, 'bin', 'node')
if (!existsSync(extracted)) {
  console.error(`[fetch-node] 展開先に node が見つかりません: ${extracted}`)
  process.exit(1)
}

copyFileSync(extracted, sidecarNode)
copyFileSync(extracted, binaryNode)
if (!isWindows) {
  chmodSync(sidecarNode, 0o755)
  chmodSync(binaryNode, 0o755)
}
rmSync(work, { recursive: true, force: true })

console.log(`[fetch-node] 配置しました:\n  ${sidecarNode}\n  ${binaryNode}`)
