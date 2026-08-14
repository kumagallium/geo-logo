import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import {
  buildFromComposition,
  compositionSchema,
  pieceSchema,
  type Composition,
  type Piece,
} from '../core/composition'
import { compile, type CompileResult } from '../core/index'
import { rasterize } from '../core/raster'
import {
  COMPOSITION_SYSTEM_PROMPT,
  compositionUserPrompt,
} from './composition-prompt'
import { critique, type Critique, type VisionConfig } from './vision'

/**
 * 引いて、見て、直す。
 *
 * これまでの生成は一度描いて終わりだった。モデルは座標を書くだけで、
 * 出来上がりを一度も見ていない。目隠しで描いているのと同じで、配置の判断が
 * 働く場面が構造として存在しなかった。
 *
 * ここでは完成形を画像に焼き、視覚モデルに講評させ、その指摘を次の作図へ
 * 戻す。人の作図で言えば「線を引いては形を直す」往復にあたる。
 *
 * 点数が上がらない round があっても打ち切らない。作図は一度悪くなってから
 * 良くなることがある。最後に最良のものを選ぶ。
 */

export type RefineRound = {
  index: number
  plan: Composition
  result: CompileResult
  critique: Critique
}

export type RefineOutcome = {
  brief: string
  /** 最も点数の高かった回 */
  best: RefineRound
  rounds: RefineRound[]
}

export type RefineOptions = {
  /** 最大何回描き直すか */
  maxRounds?: number
  /** この点数に届いたら止める */
  target?: number
  /** 画像の一辺（画素） */
  imageSize?: number
  /**
   * 直し方。
   *
   * patch: 差分だけ返させ、触れなかった部品は保つ
   * redraw: 講評を添えて丸ごと描き直させる
   *
   * 差分のほうが良いはずだったが、実測では丸ごと描き直すほうが点数が高い。
   * 講評の多くは「口を足す」「輪郭を角張らせる」のように 1 部品では実現
   * できない構造の変更で、差分だと small な移動しかできないため。
   */
  revise?: 'patch' | 'redraw'
  onRound?: (round: RefineRound) => void
}

/**
 * 直しは差分で受け取る。
 *
 * 設計を丸ごと返させると、「指摘箇所だけ直せ」と書いてもモデルは毎回すべて
 * 書き直し、できていた部分まで壊れる（実測: 眉の隆起が出た次の回で目が消えた）。
 * 何番の部品をどう動かすかだけを書かせ、適用はコードで行う。
 */
export const patchSchema = z.object({
  reason: z.string().max(200).optional(),
  edits: z
    .array(
      z.object({
        index: z.union([z.number(), z.string()]).transform((v) => {
          const n = typeof v === 'string' ? Number.parseInt(v, 10) : v
          return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
        }),
        remove: z
          .union([z.boolean(), z.string(), z.null()])
          .optional()
          .transform((v) => v === true || v === 'true'),
        x: z.union([z.number(), z.string(), z.null()]).optional(),
        y: z.union([z.number(), z.string(), z.null()]).optional(),
        size: z.union([z.number(), z.string(), z.null()]).optional(),
        form: z.union([z.string(), z.null()]).optional(),
        role: z.union([z.string(), z.null()]).optional(),
      }),
    )
    .max(4)
    .default([]),
  add: z.array(pieceSchema).max(2).default([]),
})

export type Patch = z.infer<typeof patchSchema>

/** 差分を前回の設計へ当てる。触れられなかった部品はそのまま残る。 */
export function applyPatch(plan: Composition, patch: Patch): Composition {
  const pieces: Piece[] = plan.pieces.map((p) => ({ ...p }))
  const removed = new Set<number>()

  for (const e of patch.edits) {
    const target = pieces[e.index]
    if (!target) continue
    if (e.remove) {
      removed.add(e.index)
      continue
    }
    // 部分的な上書き。渡されなかった項目は元の値を保つ
    const merged = pieceSchema.parse({
      ...target,
      ...(e.x !== undefined && e.x !== null ? { x: e.x } : {}),
      ...(e.y !== undefined && e.y !== null ? { y: e.y } : {}),
      ...(e.size !== undefined && e.size !== null ? { size: e.size } : {}),
      ...(e.form ? { form: e.form } : {}),
      ...(e.role ? { role: e.role } : {}),
    })
    pieces[e.index] = merged
  }

  const kept = pieces.filter((_, i) => !removed.has(i))
  // すべて消してしまう指示は受け付けない
  const next = kept.length > 0 ? [...kept, ...patch.add] : [...pieces, ...patch.add]
  return { ...plan, pieces: next.slice(0, 16) }
}

export function revisePrompt(brief: string, plan: Composition, c: Critique): string {
  const listing = plan.pieces
    .map(
      (p, i) =>
        `${i}: ${p.label || p.form} form=${p.form} role=${p.role} x=${p.x} y=${p.y} size=${p.size}${p.mirror ? ' mirror' : ''}`,
    )
    .join('\n')

  return [
    `「${brief}」のロゴを設計しています。いまの部品はこれです。`,
    '',
    listing,
    '',
    '画像にして見せたところ、次の講評が返りました。',
    `- 見え方: ${c.reads}`,
    `- ${brief} として読めるか: ${c.score} / 10`,
    c.fix ? `- 直すべき点: ${c.fix}` : '',
    '',
    '**直す部品だけを差分で返してください。触れなかった部品はそのまま残ります。**',
    '座標系は x が右、y が下、原点が中心。単位はモジュールです。',
    '',
    '{',
    '  "reason": "何を狙って直すか",',
    '  "edits": [{ "index": 0, "y": 1.5, "size": 2.2 }],',
    '  "add": []',
    '}',
    '',
    '一度に直すのは 1〜2 箇所まで。多く動かすと、できている部分まで壊れます。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 講評を添えて丸ごと描き直させる */
export function redrawPrompt(brief: string, plan: Composition, c: Critique): string {
  return [
    `次の要件でロゴを設計しています。要件: ${brief}`,
    '',
    'いま出来ている設計はこれです。',
    JSON.stringify({ ratio: plan.ratio, pieces: plan.pieces }),
    '',
    'これを画像にして見せたところ、次の講評が返りました。',
    `- 見え方: ${c.reads}`,
    `- ${brief} として読めるか: ${c.score} / 10`,
    c.fix ? `- 直すべき点: ${c.fix}` : '',
    '',
    'この指摘を反映した設計を返してください。',
    'できている部分（講評で問題にされていない部品）は、座標も大きさも変えないでください。',
  ]
    .filter(Boolean)
    .join('\n')
}

async function draw(model: LanguageModel, system: string, prompt: string): Promise<Composition> {
  const generated = await generateObject({
    model,
    schema: compositionSchema,
    system,
    prompt,
    maxOutputTokens: 4000,
  })
  return generated.object as Composition
}

async function askPatch(model: LanguageModel, prompt: string): Promise<Patch> {
  const generated = await generateObject({
    model,
    schema: patchSchema,
    system: '幾何ロゴの作図を差分で直します。JSON のみを返してください。',
    prompt,
    maxOutputTokens: 1200,
  })
  return generated.object as Patch
}

export async function refineLogo(
  brief: string,
  model: LanguageModel,
  vision: VisionConfig,
  options: RefineOptions = {},
): Promise<RefineOutcome> {
  const maxRounds = Math.max(1, Math.min(options.maxRounds ?? 4, 8))
  const target = options.target ?? 8
  const imageSize = options.imageSize ?? 320
  const mode = options.revise ?? 'redraw'

  const rounds: RefineRound[] = []
  let plan = await draw(model, COMPOSITION_SYSTEM_PROMPT, compositionUserPrompt(brief))

  for (let i = 0; i < maxRounds; i++) {
    const result = compile(buildFromComposition(plan))
    const png = rasterize(result.built, { size: imageSize })
    const c = await critique(png, brief, vision)

    const round: RefineRound = { index: i, plan, result, critique: c }
    rounds.push(round)
    options.onRound?.(round)

    if (c.score >= target || i === maxRounds - 1) break
    try {
      plan =
        mode === 'patch'
          ? applyPatch(plan, await askPatch(model, revisePrompt(brief, plan, c)))
          : await draw(model, COMPOSITION_SYSTEM_PROMPT, redrawPrompt(brief, plan, c))
    } catch {
      // 直しが取れなければ最初から描き直す。輪は止めない
      plan = await draw(model, COMPOSITION_SYSTEM_PROMPT, compositionUserPrompt(brief))
    }
  }

  // 最後の回が最良とは限らない。点数で選ぶ
  const best = rounds.reduce((a, b) => (b.critique.score > a.critique.score ? b : a))
  return { brief, best, rounds }
}
