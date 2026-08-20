import type { LogoDesign } from '../../core/index'
import { aiErrorFromResponse } from '../../lib/ai-error'
import { apiFetch } from '../../lib/api-base'
import { CodedError } from '../../lib/ai-error-codes'
import { createModel } from '../../lib/create-model'
import { designLogo, modeForVariant } from '../../lib/design-agent'
import { detectRuntimeMode } from '../../lib/runtime-mode'
import { getDefaultLLMModel } from '../settings/store'

export type DesignResponse = {
  design: LogoDesign
  attempts: { index: number; problems: string[] }[]
  /** 実際に使われたモデル名 */
  model: string
}

/**
 * ブリーフから設計を生成する。
 *
 * サーバーモード: Hono の /api/design。キーはサーバーに置いたまま。
 * 静的モード:     ブラウザから直接プロバイダーを叩く。設計エージェント
 *                （lib/design-agent.ts）はどちらでも同じものを使う。
 */
export type CandidateResult =
  | {
      ok: true
      design: LogoDesign
      attempts: DesignResponse['attempts']
      model: string
      /** 絵の経路のみ。拡散モデルは prompt + seed で決定的なので、これを
       *  引き継ぐと「選んだ案の構図を保ったまま指示だけ変える」ができる */
      seed?: number
    }
  | { ok: false; error: unknown }

/**
 * 同じブリーフから候補を N 件生成する。
 *
 * 構図の良し悪しは機械判定できない。同心配置のように「離れているが正しい」構成が
 * あり、要素間の距離で弾くと良い設計まで落ちてしまう（Signal サンプルがまさにそれ）。
 * 幾何の破綻・小サイズでの破綻は自動で弾き、最後の美的判断は人に委ねる分担にする。
 *
 * **画像生成器が設定されていれば、そちらを使う**（絵 → シルエット → 作図の復元）。
 * 幾何を言語モデルに書かせる経路は構図が「円の集まり」に寄る。絵の経路は構図と
 * 白の切り方が画像モデルの得意なので、仕上がりが段違いになる（実測）。
 *
 * onCandidate は 1 件できるたびに呼ぶ。絵の経路は 1 件 30 秒級なので、
 * 全部を待たせず、できた順に見せる。
 */
export type RequestDesignsOptions = {
  onCandidate?: (result: CandidateResult) => void
  /** 選択中の候補の seed。1 件目に引き継ぎ、選んだ構図を保ったまま磨く */
  baseSeed?: number
  /** 題名に使う短い名前（brief は会話の累積で長くなる） */
  name?: string
  /**
   * 磨くときに引き継ぐ設計意図。
   *
   * ブラッシュアップではコンセプトを引き直さない（選んだ案の構図に錨を下ろす
   * ため）。そのぶん、選んだ案の題名と意図を持ち越さないと、レポートが
   * 「画像から復元した作図」という既定文に戻ってしまう（実測）。
   */
  concept?: string
  /** 磨くときに引き継ぐ対称性 */
  symmetry?: 'mirror' | 'free'
  /**
   * 磨くときに引き継ぐ視覚記述（選んだ設計の design.visual）。
   *
   * これが無いと、サーバーは会話履歴を生の文字列で画像モデルへ渡してしまい
   * 指示が効かなくなる（実測）。instruction とあわせて渡すと、サーバーが
   * 「今の絵の説明 + 直近の指示」から更新後の視覚記述を作り直す。
   */
  previousVisual?: string
  /** 磨くときの直近の指示（会話履歴の全文ではなく、最新の一言） */
  instruction?: string
}

export async function requestDesigns(
  brief: string,
  count: number,
  options: RequestDesignsOptions = {},
): Promise<CandidateResult[]> {
  const { onCandidate } = options
  const n = Math.max(1, count)
  const image = await imageGenAvailable()
  if (image) return requestImageDesigns(brief, n, options)

  // 候補ごとに型の系統を割り当てる。同じプロンプトを N 回投げるとモデルは
  // ほぼ同じ型を選び、候補が重複して選ぶ意味がなくなる（実測）。
  // 1 件だけのときは絞らず、最も合う型を自由に選ばせる。
  const runs = Array.from({ length: n }, (_, i) =>
    requestDesign(brief, n > 1 ? i : undefined)
      .then((r): CandidateResult => ({ ok: true, ...r }))
      .catch((error): CandidateResult => ({ ok: false, error }))
      .then((r) => {
        onCandidate?.(r)
        return r
      }),
  )
  return Promise.all(runs)
}

/** サーバーモードで画像生成器が設定されているか。読めない事情はすべて「無し」に倒す */
async function imageGenAvailable(): Promise<boolean> {
  if ((await detectRuntimeMode()) !== 'server') return false
  try {
    const res = await apiFetch('api/image/config')
    if (!res.ok) return false
    const info = (await res.json()) as { command: string | null }
    return typeof info.command === 'string' && info.command.length > 0
  } catch {
    return false
  }
}

/**
 * 絵の経路で候補を N 件、**直列に**生成する。
 *
 * サーバー側も 1 件ずつしか捌かない（拡散モデルはピーク数 GB を使う）。並行で
 * 投げても待ち行列に並ぶだけで、後ろの要求ほど無応答時間が伸びてタイムアウト
 * 境界に寄る。こちらから直列に送れば、1 要求の待ちは常に生成 1 回ぶんで済む。
 */
type ImageConcept = {
  title: string
  visual: string
  rationale: string
  /** 描法。brush は筆致で描かせる案（4 案のうち 1 案） */
  treatment?: 'flat' | 'brush'
  /** 左右対称にすべきか。題材の意味で決まるので言語モデルに言わせる */
  symmetry?: 'mirror' | 'free'
}

/**
 * コンセプト仮説を先に作る（言語モデル）。
 *
 * seed だけを散らすと解釈が 1 つに固定され、候補がほぼ同じ絵になる（実測）。
 * 「何をモチーフに、どんな比喩で表すか」を数案に割ってから各案を描く。
 * モデル未登録・失敗時は null（呼び元は seed 散らしへ落ちる）。
 */
async function fetchImageConcepts(brief: string, count: number): Promise<ImageConcept[] | null> {
  try {
    const res = await apiFetch('api/image/concepts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief, count }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { concepts?: ImageConcept[] }
    return json.concepts?.length ? json.concepts : null
  } catch {
    return null
  }
}

async function requestImageDesigns(
  brief: string,
  count: number,
  options: RequestDesignsOptions,
): Promise<CandidateResult[]> {
  // 新規生成はコンセプトで割る。ブラッシュアップ（baseSeed あり）は選んだ案の
  // 構図に錨を下ろしたままにしたいので、コンセプトを引き直さない
  const concepts =
    options.baseSeed === undefined ? await fetchImageConcepts(brief, count) : null

  const results: CandidateResult[] = []
  for (let i = 0; i < count; i++) {
    // 1 件目は選択中の候補の seed を引き継ぐ（構図を保って磨く）。
    // 残りは seed 未指定＝サーバーが散らす（別の当たりを探す）
    const seed = i === 0 ? options.baseSeed : undefined
    const concept = concepts?.[i % concepts.length]
    const result = await apiFetch('api/image/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brief,
        seed,
        // コンセプト経由では案名を題名にする（候補の下に解釈の違いが見える）
        name: concept?.title ?? options.name,
        subject: concept?.visual,
        concept: concept?.rationale ?? options.concept,
        brush: concept?.treatment === 'brush',
        symmetry: concept?.symmetry ?? options.symmetry,
        // concept が無いとき（磨くとき）だけサーバー側で使われる。
        // concept があるときは無視されるので、常に渡してよい
        previousVisual: options.previousVisual,
        instruction: options.instruction,
      }),
    })
      .then(async (res) => {
        if (!res.ok) throw await aiErrorFromResponse(res, '画像からの作図に失敗しました')
        const json = (await res.json()) as DesignResponse & { seed?: number }
        return {
          ok: true as const,
          design: json.design,
          attempts: json.attempts ?? [],
          model: json.model,
          seed: json.seed,
        }
      })
      .catch((error): CandidateResult => ({ ok: false, error }))
    options.onCandidate?.(result)
    results.push(result)
    // まだ 1 件もできていないのに失敗したなら、生成器そのものが壊れている
    // （コマンド不在・モデル不在）。残りも同じ失敗になるだけなので打ち切る
    if (!result.ok && results.every((r) => !r.ok)) break
  }
  return results
}

export async function requestDesign(
  brief: string,
  variantIndex?: number,
): Promise<DesignResponse> {
  const mode = await detectRuntimeMode()

  if (mode === 'static') {
    const config = getDefaultLLMModel()
    if (!config) {
      throw new CodedError('No model registered', 'NO_MODEL_REGISTERED')
    }
    try {
      const outcome = await designLogo(
        brief,
        createModel(config),
        variantIndex === undefined ? undefined : modeForVariant(variantIndex),
      )
      return {
        design: outcome.result.design,
        attempts: outcome.attempts,
        model: config.name,
      }
    } catch (err) {
      throw asBrowserAiError(err)
    }
  }

  const res = await apiFetch('api/design', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief, model: undefined, variantIndex }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, '設計の生成に失敗しました')
  return (await res.json()) as DesignResponse
}

/**
 * ブラウザ直叩き固有の失敗を分類する。
 * CORS で弾かれた fetch は TypeError になり、レスポンスもステータスも取れないため、
 * ネットワーク断と区別がつかない。ここで静的モード特有の原因として案内へ寄せる。
 */
function asBrowserAiError(err: unknown): unknown {
  if (err instanceof TypeError) {
    return new CodedError(
      err.message || 'Failed to reach the provider from the browser',
      'BROWSER_CORS_BLOCKED',
    )
  }
  const status = (err as { statusCode?: number } | null)?.statusCode
  if (status === 401) return new CodedError('Invalid API key', 'INVALID_API_KEY')
  if (status === 403) return new CodedError('API key forbidden', 'API_KEY_FORBIDDEN')
  return err
}
