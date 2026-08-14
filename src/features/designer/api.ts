import { ARCHETYPE_FAMILIES } from '../../core/archetypes'
import type { LogoDesign } from '../../core/index'
import { aiErrorFromResponse } from '../../lib/ai-error'
import { CodedError } from '../../lib/ai-error-codes'
import { createModel } from '../../lib/create-model'
import { designLogo } from '../../lib/design-agent'
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
 * 同じブリーフから候補を N 件並行生成する。
 *
 * 構図の良し悪しは機械判定できない。同心配置のように「離れているが正しい」構成が
 * あり、要素間の距離で弾くと良い設計まで落ちてしまう（Signal サンプルがまさにそれ）。
 * 幾何の破綻・小サイズでの破綻は自動で弾き、最後の美的判断は人に委ねる分担にする。
 */
export async function requestDesigns(brief: string, count: number): Promise<CandidateResult[]> {
  const n = Math.max(1, count)
  // 候補ごとに型の系統を割り当てる。同じプロンプトを N 回投げるとモデルは
  // ほぼ同じ型を選び、候補が重複して選ぶ意味がなくなる（実測）。
  // 1 件だけのときは絞らず、最も合う型を自由に選ばせる。
  const runs = Array.from({ length: n }, (_, i) =>
    requestDesign(brief, n > 1 ? i : undefined)
      .then((r): CandidateResult => ({ ok: true, ...r }))
      .catch((error): CandidateResult => ({ ok: false, error })),
  )
  return Promise.all(runs)
}

export async function requestDesign(
  brief: string,
  familyIndex?: number,
): Promise<DesignResponse> {
  const mode = await detectRuntimeMode()

  if (mode === 'static') {
    const config = getDefaultLLMModel()
    if (!config) {
      throw new CodedError('No model registered', 'NO_MODEL_REGISTERED')
    }
    try {
      const family =
        familyIndex === undefined
          ? undefined
          : ARCHETYPE_FAMILIES[familyIndex % ARCHETYPE_FAMILIES.length]
      const outcome = await designLogo(brief, createModel(config), family)
      return {
        design: outcome.result.design,
        attempts: outcome.attempts,
        model: config.name,
      }
    } catch (err) {
      throw asBrowserAiError(err)
    }
  }

  const res = await fetch(`${import.meta.env.BASE_URL}api/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief, model: undefined, familyIndex }),
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
