import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { generateImage } from 'ai'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * シンボルを「絵」として先に作らせる。
 *
 * ここまでは順方向だった——モデルに幾何（関係やラフの点）を書かせ、それを
 * 組み立てる。だが**構図と白の切り方を幾何の言葉で決める**のは、言語モデルに
 * とって間接的すぎる仕事で、出来上がりが素人の絵になる。実測でも、輪郭を
 * 白抜きで消すと「円の上に円が 2 つ」しか残らなかった（＝輪郭が何も語って
 * いない）。
 *
 * 画像モデルは逆に、構図と白の切り方だけが得意で、幾何は持っていない。
 * **絵を先に作らせ、幾何は後から当てる**（core/reconstruct.ts）。役割が
 * ひっくり返るが、こちらの順のほうが両者の得意に沿っている。
 *
 * 生成物は必ず**二値のシルエット**でなければならない。復元は明度で切るので、
 * 階調・影・線画・背景があると輪郭が拾えない。プロンプトの大半はそのための
 * 指定に費やす。
 */

/**
 * 画像を作れるプロバイダー。
 *
 * さくら AI Engine には**画像生成が無い**（実測: `/v1/models` は 12 件すべて
 * チャット・埋め込み・音声。VL モデルは画像を読むだけで描けない）。言語モデルを
 * そちらに寄せていても、この工程だけは別の宛先が要る。
 */
export type ImageProvider = 'google' | 'openai' | 'command'

export type ImageConfig = {
  provider: ImageProvider
  /** provider のモデル ID。command では使わない */
  modelId: string
  /** command では要らない */
  apiKey: string
  /** OpenAI 互換のエンドポイント。省略で本家 */
  apiBase?: string | null
  /** 正方形の一辺 */
  size?: number
  /**
   * 手元の生成器を呼ぶコマンド。`{prompt}` `{out}` `{size}` `{seed}` を差し替える。
   *
   * ローカルの拡散モデルは道具ごとに API が違う（Draw Things・ComfyUI・mflux で
   * 三者三様）。宛先ごとにアダプタを書くと、道具を替えるたびにこちらを直す
   * ことになる。**PNG を 1 枚書いてくれれば何でもいい**ので、その一点だけを
   * 約束させる。
   */
  command?: string
  /**
   * 乱数の種。候補を複数出すとき、これを変えないと全候補が同じ絵になる
   * （拡散モデルは prompt + seed で決定的）。`{seed}` の差し替え値。
   */
  seed?: number
  /** 筆致で描かせる。様式の指定なので、プロンプトの節ごと切り替わる */
  brush?: boolean
}

/** 無料枠があるほうを既定にする（Google AI Studio は 1 日 500 枚まで無償） */
export const DEFAULT_IMAGE_MODEL: Record<Exclude<ImageProvider, 'command'>, string> = {
  google: 'gemini-2.5-flash-image',
  openai: 'gpt-image-1',
}

/**
 * 復元できる絵の条件をプロンプトへ焼き込む。
 *
 * 「ロゴを作って」だけだと、影・グラデーション・枠・文字・複数案の並びが
 * 返る。どれも明度で切った瞬間に壊れる。**何を描くか**より**どう出力するか**
 * のほうを長く書く。
 */
export function symbolImagePrompt(brief: string, options: { brush?: boolean } = {}): string {
  // 筆致の案。復元は絵を忠実になぞるので、**輪郭のゆらぎは絵から来る**。画素の
  // residue による偶然のゆらぎは強弱を付けられず様式にならないが、画像モデルに
  // 筆で描かせたゆらぎは線の勢いと圧の変化を伴い、意図した描法になる。
  // 平面的なマークとは要求が正反対（一定の線幅・端の切り揃え）なので、
  // 様式の節だけを丸ごと差し替える。
  if (options.brush) {
    return `A single ink-brush logo symbol: ${brief}

Output requirements — these are absolute:
- Pure black on a pure white background. Only #000000 and #FFFFFF.
- No gradients, no grey, no washes, no spatter, no paper texture, no noise.
- No frame, no border, no background shapes.
- No text, no letters, no numbers, no signature, no seal, no watermark.
- One single mark, centred, filling about 70% of the canvas. Not a grid of options.
- Flat 2D. No perspective, no 3D, no drop shadow.

Design requirements:
- Drawn as if in ONE confident breath with a broad ink brush — the gesture is
  the design. Think of a Zen ensō circle: a single sweep, not a traced outline.
- The stroke swells and tapers along its length: heavier where the brush presses,
  thinner where it lifts. The width should vary by at least 2:1 from thickest to
  thinnest, and that variation must follow the direction of the stroke.
- Any waver in the line is the momentum of the hand, not roughness: few, long,
  smooth undulations — never many small wobbles, never a jagged edge.
- The stroke may open (leave a gap) where the brush lifts. Ends are cut by the
  brush leaving the paper, so they may taper to a point or stop bluntly.
- Bold and simple. The stroke must be thick enough to stay readable at 16 pixels.
- Keep the subject recognisable — the gesture describes the subject, it does not
  replace it.`
  }

  return `A single flat vector-style logo symbol: ${brief}

Output requirements — these are absolute:
- Pure black silhouette on a pure white background. Only #000000 and #FFFFFF.
- No gradients, no shading, no grey, no anti-aliased soft edges, no texture, no noise.
- No outlines around the mark, no frame, no border, no background shapes.
- No text, no letters, no numbers, no signature, no watermark.
- One single mark, centred, filling about 70% of the canvas. Not a grid of options.
- Flat 2D. No perspective, no 3D, no drop shadow, no reflection.

Design requirements:
- This is a LOGO MARK for a brand, not an illustration. Premium crest energy:
  decisive, sharp, instantly memorable.
- Angular styling: straight chiseled cuts and sharp diagonal negative-space
  slashes carve the internal features. Internal separations are faceted
  geometric planes with crisp corners — not soft rounded holes.
- Mix long confident curves for the outer silhouette with hard straight cuts
  inside. The contrast between curve and cut is the style.
- Reduce to the most iconic crop — the single most recognisable part of the
  subject — unless the brief says otherwise.
- The silhouette alone must identify the subject. Separate overlapping parts
  with clean white gaps of consistent weight.
- Bold, simple, few chunky masses. No ragged or noisy edges. It must stay
  readable at 16 pixels and work as an app icon.
- Prefer the fewest, largest masses that still read. Drop any feature smaller
  than about 5% of the canvas — no tiny fussy details.
- If the concept calls for a line-based construction (a ring, a constellation,
  connected strokes), draw it with bold uniform lines at least 4% of the
  canvas thick — still pure black on pure white.
- If the brief itself asks for a soft, gentle or friendly tone, relax the
  cuts and follow the brief.`
}

export type GeneratedImage = {
  /** PNG のバイト列 */
  png: Uint8Array
  /** 実際に投げたプロンプト */
  prompt: string
}

/**
 * 手元の生成器をコマンドとして呼ぶ。
 *
 * シェルは通さない。プロンプトは改行と引用符を含むので、シェルへ渡すと
 * 引用の壊れ方でしか失敗しなくなる。テンプレートを空白で割ってから語ごとに
 * 差し替えれば、プロンプトは最後まで 1 つの引数のまま運べる。
 */
async function runCommand(
  template: string,
  prompt: string,
  size: number,
  seed?: number,
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'geologo-'))
  const out = join(dir, 'image.png')
  // プロンプトは複数行。引数で渡せない道具のために、ファイルでも渡せるようにする
  const promptFile = join(dir, 'prompt.txt')
  writeFileSync(promptFile, prompt)
  try {
    const parts = template.trim().split(/\s+/)
    if (parts.length === 0) throw new Error('コマンドが空です')
    const fill = (s: string) =>
      s
        .replaceAll('{prompt}', prompt)
        .replaceAll('{promptFile}', promptFile)
        .replaceAll('{out}', out)
        .replaceAll('{size}', String(size))
        .replaceAll('{seed}', String(seed ?? 0))
    const [bin, ...args] = parts.map(fill)
    if (!template.includes('{out}')) {
      throw new Error('コマンドに {out} が要ります（そこへ PNG を書いてもらいます）')
    }
    await run(bin, args, { maxBuffer: 64 * 1024 * 1024 })
    return new Uint8Array(readFileSync(out))
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(`手元の生成器が PNG を書きませんでした: ${why}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 絵を 1 枚作る。
 *
 * 画像モデルは言語モデルと別系統なので、既存の createModel は通さない。
 * 互換エンドポイントも同じ口で扱えるよう baseURL だけ差し替える。
 */
export async function generateSymbolImage(
  brief: string,
  config: ImageConfig,
): Promise<GeneratedImage> {
  const size = config.size ?? 1024
  const prompt = symbolImagePrompt(brief, { brush: config.brush })

  if (config.provider === 'command') {
    if (!config.command) throw new Error('GEOLOGO_IMAGE_COMMAND が設定されていません')
    return { png: await runCommand(config.command, prompt, size, config.seed), prompt }
  }

  const model =
    config.provider === 'google'
      ? createGoogleGenerativeAI({ apiKey: config.apiKey }).image(config.modelId)
      : createOpenAI({
          apiKey: config.apiKey,
          ...(config.apiBase ? { baseURL: config.apiBase } : {}),
        }).image(config.modelId)

  // Gemini の画像モデルは size を取らず縦横比で受ける。指定の仕方が違うだけで
  // 正方形が欲しいのは同じなので、宛先ごとに言い換える
  const result = await generateImage({
    model,
    prompt,
    n: 1,
    ...(config.provider === 'google'
      ? { aspectRatio: '1:1' as const }
      : { size: `${size}x${size}` as const }),
  })

  const image = result.image
  if (!image?.uint8Array?.length) throw new Error('画像が返りませんでした')
  return { png: image.uint8Array, prompt }
}

/**
 * 失敗の理由を、こちらの言葉に直す。
 *
 * 枠を使い切ったときは 429 が返るだけで課金には切り替わらない（無償枠は
 * 「請求先を紐づけていないプロジェクト」の意味なので、紐づけない限り課金され
 * ようがない）。ただし生の 429 は「壊れた」とも読めるので、**待てば直る**のか
 * **直すべき何かがある**のかを言い分ける。
 */
export function explainImageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) {
    return [
      '画像モデルの枠を使い切りました（課金には切り替わりません）。',
      '日付が変わるまで待つか、別の宛先を指定してください。',
      `元のメッセージ: ${message}`,
    ].join('\n')
  }
  if (/401|403|API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) {
    return `鍵が通りませんでした。宛先と鍵の組み合わせを確認してください。\n元のメッセージ: ${message}`
  }
  if (/safety|blocked|policy|PROHIBITED/i.test(message)) {
    return `題材が画像モデルの基準で拒まれました。ブリーフを変えてください。\n元のメッセージ: ${message}`
  }
  return message
}

/**
 * 環境変数から画像モデルの設定を読む。
 *
 * 言語モデルの設定（data/models.json）とは別に持つ。役割が違うので、
 * 同じ一覧に混ぜると「どちらのモデルか」を毎回確かめることになる。
 */
export function imageConfigFromEnv(env: Record<string, string | undefined>): ImageConfig | null {
  const named = env.GEOLOGO_IMAGE_PROVIDER?.trim().toLowerCase()

  // 手元の生成器が指定されていれば、鍵の有無に関わらずそちらを使う。
  // 「無料で回したい」が動機なので、鍵より優先されるほうが素直
  const command = env.GEOLOGO_IMAGE_COMMAND
  if (command && named !== 'google' && named !== 'openai') {
    return {
      provider: 'command',
      modelId: 'command',
      apiKey: '',
      command,
      size: env.GEOLOGO_IMAGE_SIZE ? Number(env.GEOLOGO_IMAGE_SIZE) : 1024,
    }
  }
  const google = env.GEOLOGO_IMAGE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY
  const openai = env.GEOLOGO_IMAGE_API_KEY || env.OPENAI_API_KEY

  // 宛先を書いていなければ、鍵のあるほうを採る。Google を先に見るのは
  // 無料枠があるため（言語モデルの宛先とは無関係に決まる）
  const provider: Exclude<ImageProvider, 'command'> =
    named === 'google' || named === 'openai'
      ? named
      : env.GOOGLE_GENERATIVE_AI_API_KEY
        ? 'google'
        : 'openai'

  const apiKey = provider === 'google' ? google : openai
  if (!apiKey) return null
  return {
    provider,
    modelId: env.GEOLOGO_IMAGE_MODEL || DEFAULT_IMAGE_MODEL[provider],
    apiKey,
    apiBase: env.GEOLOGO_IMAGE_BASE_URL || null,
    size: env.GEOLOGO_IMAGE_SIZE ? Number(env.GEOLOGO_IMAGE_SIZE) : 1024,
  }
}
