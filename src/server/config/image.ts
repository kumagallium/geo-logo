// 画像生成器（ローカルコマンド）の設定
//
// 画像先行の復元経路（絵 → シルエット → 作図）の入口。生成器はコマンド 1 本の
// 約束（{out} へ PNG を書く）だけで繋がる（lib/image-agent.ts の command
// プロバイダー）。ここではそのコマンドを data ディレクトリの image.json に持つ。
//
// API キーと違い秘密ではないが、モデル設定と同じ場所に置くことで
// 「アプリの設定はすべて GEOLOGO_DATA_DIR の下」を保つ。

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

function configPath(): string {
  return join(getDataDir(), 'image.json')
}

/**
 * 保存済みの設定を返す。無ければ環境変数 GEOLOGO_IMAGE_COMMAND を見る
 * （CLI・開発時はファイルを作らず env だけで試せる）。
 */
export function getImageConfig(): ImageGenConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as ImageGenConfig
    if (typeof parsed?.command === 'string' && parsed.command.includes('{out}')) {
      return { command: parsed.command, size: numberOr(parsed.size, 512) }
    }
  } catch {
    // ENOENT・破損は「未設定」として扱う。破損でモデル追加系と違い失うものが
    // ないので、warn より未設定へ倒すほうが復帰が簡単
  }
  const env = process.env.GEOLOGO_IMAGE_COMMAND
  if (env?.includes('{out}')) return { command: env, size: 512 }
  return null
}

/** null で削除。コマンドは {out} 必須（PNG の受け取り先が無いと成立しない） */
export function setImageConfig(config: ImageGenConfig | null): void {
  if (!config) {
    rmSync(configPath(), { force: true })
    return
  }
  if (!config.command.includes('{out}')) {
    throw new Error('コマンドに {out} が要ります（そこへ PNG を書いてもらいます）')
  }
  writeFileSync(
    configPath(),
    JSON.stringify({ command: config.command, size: numberOr(config.size, 512) }, null, 2),
    'utf-8',
  )
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback
}

/**
 * この Mac で使える既定コマンドの提案。
 *
 * mflux の量子化済み z-image-turbo（一度 mflux-save したもの）を想定する。
 * フル精度は読むだけで 27GB 級で、実測でマシン全体が固まった。量子化済みなら
 * ピーク 6GB・1 枚 30 秒。パスは**絶対パスで返す**——サイドカーは Finder 起動だと
 * PATH が /usr/bin:/bin 程度しかなく、~ の展開も execFile はしない。
 *
 * 保存先は ~/.cache/geologo（空白なし）。コマンドは空白で語に割るので、
 * "Application Support" のような空白入りパスはテンプレートに入れられない。
 */
export function suggestImageCommand(): string | null {
  const bin = join(homedir(), '.local', 'bin', 'mflux-generate-z-image-turbo')
  if (!existsSync(bin)) return null
  const saved = join(homedir(), '.cache', 'geologo', 'z-image-turbo-4bit')
  const model = existsSync(saved) ? `--model ${saved} --base-model z-image-turbo ` : ''
  return `${bin} ${model}--prompt-file {promptFile} --seed {seed} --width {size} --height {size} --steps 8 --output {out}`
}
