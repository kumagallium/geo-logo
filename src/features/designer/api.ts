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
  | { ok: true; design: LogoDesign; attempts: DesignResponse['attempts']; model: string }
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
export async function requestDesigns(
  brief: string,
  count: number,
  onCandidate?: (result: CandidateResult) => void,
): Promise<CandidateResult[]> {
  const n = Math.max(1, count)
  const image = await imageGenAvailable()
  if (image) return requestImageDesigns(brief, n, onCandidate)

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
async function requestImageDesigns(
  brief: string,
  count: number,
  onCandidate?: (result: CandidateResult) => void,
): Promise<CandidateResult[]> {
  const results: CandidateResult[] = []
  for (let i = 0; i < count; i++) {
    const result = await apiFetch('api/image/design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief }),
    })
      .then(async (res) => {
        if (!res.ok) throw await aiErrorFromResponse(res, '画像からの作図に失敗しました')
        const json = (await res.json()) as DesignResponse
        return { ok: true as const, design: json.design, attempts: json.attempts ?? [], model: json.model }
      })
      .catch((error): CandidateResult => ({ ok: false, error }))
    onCandidate?.(result)
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
