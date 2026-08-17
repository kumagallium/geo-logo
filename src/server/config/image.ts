// 画像生成器（ローカルコマンド）の設定
//
// 画像先行の復元経路（絵 → シルエット → 作図）の入口。生成器はコマンド 1 本の
// 約束（{out} へ PNG を書く）だけで繋がる（lib/image-agent.ts の command
// プロバイダー）。
//
// **使える環境では黙って有効になる。** 幾何を言語モデルに書かせる経路とは
// 仕上がりが段違いで、「設定画面でコマンドテンプレートを貼ると良くなる」は
// 利用者に道具の内部事情を背負わせすぎる（実測: 何を入れる欄なのか全く
// 伝わらなかった）。明示設定は上書きとして残し、既定は自動検出にする。

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getDataDir } from './models.js'

export type ImageGenConfig = {
  /** {prompt} {promptFile} {out} {size} {seed} を差し替えて実行する */
  command: string
  /** 正方形の一辺。省略は 512 */
  size?: number
}

/** どこから来た設定か。UI が「なぜ使えている / いない」を言えるようにする */
export type ImageGenSource = 'saved' | 'env' | 'auto' | 'disabled' | 'none'

type StoredImageGen = {
  command?: string
  size?: number
  /** 明示的に切った印。自動検出より強い */
  disabled?: boolean
}

function configPath(): string {
  return join(getDataDir(), 'image.json')
}

function readStored(): StoredImageGen | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as StoredImageGen
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    // ENOENT・破損は「未保存」。モデル設定と違い失うものがないので未保存へ倒す
    return null
  }
}

/**
 * 実際に使う設定と、その出どころ。
 *
 * 優先順: 明示 OFF ＞ 保存済みコマンド ＞ 環境変数 ＞ 自動検出 ＞ 無し。
 * 「切った」を自動検出より強くしないと、OFF にしても次の起動で復活する。
 */
export function resolveImageGen(): { config: ImageGenConfig | null; source: ImageGenSource } {
  const stored = readStored()
  if (stored?.disabled) return { config: null, source: 'disabled' }
  if (typeof stored?.command === 'string' && stored.command.includes('{out}')) {
    return {
      config: { command: stored.command, size: numberOr(stored.size, 512) },
      source: 'saved',
    }
  }
  const env = process.env.GEOLOGO_IMAGE_COMMAND
  if (env?.includes('{out}')) return { config: { command: env, size: 512 }, source: 'env' }
  const suggestion = suggestImageCommand()
  if (suggestion) return { config: { command: suggestion, size: 512 }, source: 'auto' }
  return { config: null, source: 'none' }
}

export function getImageConfig(): ImageGenConfig | null {
  return resolveImageGen().config
}

/** 明示コマンドの保存。{out} 必須（PNG の受け取り先が無いと成立しない） */
export function setImageConfig(config: ImageGenConfig): void {
  if (!config.command.includes('{out}')) {
    throw new Error('コマンドに {out} が要ります（そこへ PNG を書いてもらいます）')
  }
  writeFileSync(
    configPath(),
    JSON.stringify({ command: config.command, size: numberOr(config.size, 512) }, null, 2),
    'utf-8',
  )
}

/**
 * ON/OFF の切り替え。
 * OFF は「切った」を書き残す（自動検出に勝つため）。ON は保存を消して
 * 自動検出へ戻す（保存済みコマンドがあった場合も、それごと白紙に戻る——
 * 上書きしたい人は改めて保存すればよい）。
 */
export function setImageGenEnabled(enabled: boolean): void {
  if (enabled) {
    rmSync(configPath(), { force: true })
    return
  }
  writeFileSync(configPath(), JSON.stringify({ disabled: true }, null, 2), 'utf-8')
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback
}

/**
 * この Mac で使える既定コマンドの提案（＝自動検出の実体）。
 *
 * mflux の量子化済み z-image-turbo（一度 mflux-save したもの）を想定する。
 * フル精度は読むだけで 27GB 級で、実測でマシン全体が固まった。量子化済みなら
 * ピーク 6GB・1 枚 30 秒。パスは**絶対パスで返す**——サイドカーは Finder 起動だと
 * PATH が /usr/bin:/bin 程度しかなく、~ の展開も execFile はしない。
 *
 * 保存先は ~/.cache/geologo（空白なし）。コマンドは空白で語に割るので、
 * "Application Support" のような空白入りパスはテンプレートに入れられない。
 *
 * 量子化済みモデルが無いのに mflux だけあるときは提案しない。フル精度で
 * 走ってマシンを固まらせるくらいなら、幾何経路に落ちるほうがまし。
 */
export function suggestImageCommand(): string | null {
  const bin = join(homedir(), '.local', 'bin', 'mflux-generate-z-image-turbo')
  if (!existsSync(bin)) return null
  const saved = join(homedir(), '.cache', 'geologo', 'z-image-turbo-4bit')
  if (!existsSync(saved)) return null
  return `${bin} --model ${saved} --base-model z-image-turbo --prompt-file {promptFile} --seed {seed} --width {size} --height {size} --steps 8 --output {out}`
}
