import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeGray } from '../core/png'
import { encodeGrayPng } from '../core/png'
import {
  DEFAULT_IMAGE_MODEL,
  explainImageError,
  generateSymbolImage,
  imageConfigFromEnv,
  symbolImagePrompt,
} from './image-agent'

describe('画像モデルの宛先', () => {
  // さくら AI Engine には画像生成が無い（/v1/models は 12 件すべてチャット・
  // 埋め込み・音声）。言語モデルをそちらに寄せていても、ここだけ別の宛先が要る
  it('鍵が無ければ動かないと言う', () => {
    expect(imageConfigFromEnv({})).toBeNull()
    expect(imageConfigFromEnv({ ANTHROPIC_API_KEY: 'a', GEOLOGO_API_KEY: 'b' })).toBeNull()
  })

  it('鍵のあるほうを自分で選ぶ', () => {
    expect(imageConfigFromEnv({ OPENAI_API_KEY: 'o' })?.provider).toBe('openai')
    expect(imageConfigFromEnv({ GOOGLE_GENERATIVE_AI_API_KEY: 'g' })?.provider).toBe('google')
  })

  // 無料枠があるほうを既定にする（Google AI Studio は 1 日 500 枚まで無償）
  it('両方あれば無償枠のあるほうを採る', () => {
    const c = imageConfigFromEnv({ GOOGLE_GENERATIVE_AI_API_KEY: 'g', OPENAI_API_KEY: 'o' })
    expect(c?.provider).toBe('google')
    expect(c?.modelId).toBe(DEFAULT_IMAGE_MODEL.google)
  })

  it('明示があればそちらが勝つ', () => {
    const c = imageConfigFromEnv({
      GOOGLE_GENERATIVE_AI_API_KEY: 'g',
      OPENAI_API_KEY: 'o',
      GEOLOGO_IMAGE_PROVIDER: 'openai',
    })
    expect(c?.provider).toBe('openai')
    expect(c?.modelId).toBe(DEFAULT_IMAGE_MODEL.openai)
  })

  it('モデル ID は上書きできる', () => {
    const c = imageConfigFromEnv({
      GOOGLE_GENERATIVE_AI_API_KEY: 'g',
      GEOLOGO_IMAGE_MODEL: 'imagen-4.0-fast-generate-001',
    })
    expect(c?.modelId).toBe('imagen-4.0-fast-generate-001')
  })
})

describe('絵の注文', () => {
  // 復元は明度で切る。階調・枠・文字が入った瞬間に輪郭が拾えないので、
  // 「何を描くか」より「どう出力するか」のほうを強く縛る
  it('復元できる条件を必ず含める', () => {
    const p = symbolImagePrompt('熊')
    expect(p).toContain('熊')
    for (const must of ['#000000', 'No gradients', 'No text', 'silhouette']) {
      expect(p).toContain(must)
    }
  })
})

describe('失敗の言い分け', () => {
  // 枠切れは「待てば直る」、鍵と題材は「直すべき何かがある」。生の 429 だけだと
  // 課金が始まったのかとも読めるので、切り替わらないことを明示する
  it('枠切れは課金と区別して伝える', () => {
    const m = explainImageError(new Error('429 RESOURCE_EXHAUSTED: quota'))
    expect(m).toContain('使い切りました')
    expect(m).toContain('課金には切り替わりません')
  })

  it('鍵と題材は別の話として伝える', () => {
    expect(explainImageError(new Error('401 API key not valid'))).toContain('鍵が通りませんでした')
    expect(explainImageError(new Error('blocked by safety policy'))).toContain('拒まれました')
  })

  it('心当たりが無ければそのまま返す', () => {
    expect(explainImageError(new Error('socket hang up'))).toBe('socket hang up')
  })
})

describe('描法', () => {
  /**
   * 輪郭のゆらぎは絵から来る。画素の residue による偶然のゆらぎは強弱を付け
   * られず様式にならないが、筆で描かせたゆらぎは線の勢いと圧の変化を伴う。
   * 平面的なマークとは要求が正反対なので、様式の節ごと入れ替わること。
   */
  it('brush では筆致の指定になり、平面的な指定は消える', () => {
    const flat = symbolImagePrompt('円')
    const brush = symbolImagePrompt('円', { brush: true })

    expect(flat).toContain('flat vector-style')
    expect(flat).toContain('No ragged or noisy edges')

    expect(brush).not.toContain('flat vector-style')
    expect(brush).not.toContain('No ragged or noisy edges')
    expect(brush).toContain('brush')
    // 太さが変わること＝筆致の核。ここが抜けると均一な線になる
    expect(brush).toMatch(/swells and tapers/)
  })

  it('どちらの描法でも、二値であることは崩さない', () => {
    for (const p of [symbolImagePrompt('円'), symbolImagePrompt('円', { brush: true })]) {
      expect(p).toContain('#000000')
      expect(p).toContain('#FFFFFF')
      expect(p).toContain('no noise')
      expect(p).toContain('16 pixels')
    }
  })
})

describe('手元の生成器', () => {
  // 道具ごとに API が違う（Draw Things・ComfyUI・mflux で三者三様）。
  // 「PNG を 1 枚書く」だけ約束させれば、どれでも同じ口で繋がる
  it('コマンドが指定されていればそちらを優先する', () => {
    const c = imageConfigFromEnv({
      GEOLOGO_IMAGE_COMMAND: 'mygen --prompt {prompt} --out {out}',
      GOOGLE_GENERATIVE_AI_API_KEY: 'g',
    })
    expect(c?.provider).toBe('command')
    expect(c?.command).toContain('{out}')
  })

  it('宛先を明示すればコマンドより鍵が勝つ', () => {
    const c = imageConfigFromEnv({
      GEOLOGO_IMAGE_COMMAND: 'mygen --out {out}',
      GOOGLE_GENERATIVE_AI_API_KEY: 'g',
      GEOLOGO_IMAGE_PROVIDER: 'google',
    })
    expect(c?.provider).toBe('google')
  })

  it('実際にコマンドを呼んで PNG を受け取る', async () => {
    // 生成器の代わりに、既知の PNG を書くだけの小さな道具を呼ぶ
    const dir = mkdtempSync(join(tmpdir(), 'geologo-test-'))
    const fixture = join(dir, 'fixture.png')
    writeFileSync(fixture, encodeGrayPng(new Uint8Array(64 * 64).fill(0), 64))
    try {
      const { png } = await generateSymbolImage('熊', {
        provider: 'command',
        modelId: 'command',
        apiKey: '',
        command: `cp ${fixture} {out}`,
      })
      expect(decodeGray(Buffer.from(png)).width).toBe(64)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('{seed} を差し替える（候補ごとに絵を変える鍵）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geologo-test-'))
    const fixture = join(dir, 'fixture.png')
    const record = join(dir, 'argv.txt')
    // 生成器の代役：第 1 引数（= 差し替え後の {seed}）を記録して PNG を書く
    const script = join(dir, 'gen.sh')
    writeFileSync(fixture, encodeGrayPng(new Uint8Array(64 * 64).fill(0), 64))
    writeFileSync(script, `#!/bin/sh\necho "$1" > ${record}\ncp ${fixture} "$2"\n`)
    try {
      await generateSymbolImage('熊', {
        provider: 'command',
        modelId: 'command',
        apiKey: '',
        command: `sh ${script} {seed} {out}`,
        seed: 42,
      })
      expect(readFileSync(record, 'utf-8').trim()).toBe('42')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('{out} を書き忘れたら、そう言う', async () => {
    await expect(
      generateSymbolImage('熊', {
        provider: 'command',
        modelId: 'command',
        apiKey: '',
        command: 'true',
      }),
    ).rejects.toThrow('{out}')
  })

  it('生成器が PNG を書かなければ、そう言う', async () => {
    await expect(
      generateSymbolImage('熊', {
        provider: 'command',
        modelId: 'command',
        apiKey: '',
        command: 'true {out}',
      }),
    ).rejects.toThrow('PNG を書きませんでした')
  })
})

describe('プロンプトのファイル渡し', () => {
  // 拡散モデルの CLI は複数行の引数を嫌うことがある。--prompt-file を持つ道具の
  // ために、内容をファイルへ書いてそのパスを差し替える
  it('{promptFile} に本文が書かれ、生成器から読める', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geologo-test-'))
    const tool = join(dir, 'tool.sh')
    const echoed = join(dir, 'echoed.txt')
    const fixture = join(dir, 'fixture.png')
    writeFileSync(fixture, encodeGrayPng(new Uint8Array(16 * 16).fill(0), 16))
    // 生成器の代わり: プロンプトファイルを控えてから、既知の PNG を出力先へ置く
    writeFileSync(tool, `#!/bin/sh\ncp "$1" "${echoed}"\ncp "${fixture}" "$2"\n`, { mode: 0o755 })
    try {
      await generateSymbolImage('熊のロゴ', {
        provider: 'command',
        modelId: 'command',
        apiKey: '',
        command: `${tool} {promptFile} {out}`,
      })
      const seen = readFileSync(echoed, 'utf8')
      expect(seen).toContain('熊のロゴ')
      expect(seen).toContain('#000000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
