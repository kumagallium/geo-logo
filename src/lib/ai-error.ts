// AI 系エラーのクライアント側共通処理（サーバー側は ai-error-codes.ts を直接使う）
//
// Graphium の src/lib/ai-error.ts を移植。Graphium は i18n レイヤに委譲していたが、
// geo-logo は日本語 UI 単一なので文言を直接持つ。
//
// - aiErrorFromResponse: fetch 失敗レスポンスの { error, code } を code 付き Error に変換
// - localizeAiError:     code → 日本語文言（code 無し / 未知はサーバーメッセージそのまま）
// - ensureModelConfigured: AI 発火経路の共通ガード（未設定なら設定画面へ誘導）

import { aiErrorCodeOf, type AiErrorCode } from './ai-error-codes'

/**
 * fetch の失敗レスポンス（JSON: { error, code? }）から code 付き Error を作る。
 * throw は呼び出し側で行う: `if (!res.ok) throw await aiErrorFromResponse(res, "...")`
 * 未知の code もそのまま Error に載せる（新サーバー + 旧クライアント定義でも情報を落とさない）。
 */
export async function aiErrorFromResponse(res: Response, fallback: string): Promise<Error> {
  const raw = await res.text().catch(() => '')
  let data: { error?: string; code?: string } = {}
  try {
    data = JSON.parse(raw) as { error?: string; code?: string }
  } catch {
    // 非 JSON ボディはこの下で先頭を切り出して残す。この生テキストが
    // 「別プロセスが port を握っている」系障害の切り分け材料になる。
  }
  const message =
    typeof data.error === 'string' && data.error
      ? data.error
      : raw.trim()
        ? `${fallback}: ${raw.trim().slice(0, 200)}`
        : fallback
  const err = new Error(message)
  if (typeof data.code === 'string') {
    ;(err as Error & { code?: string }).code = data.code
  }
  return err
}

// エラーコード → 表示文言。新しいコードを足したらここにも追加する。
const CODE_TO_MESSAGE: Record<AiErrorCode, string> = {
  NO_MODEL_REGISTERED: 'AI モデルが登録されていません。設定からモデルを追加してください。',
  INVALID_API_KEY: 'API キーが無効か期限切れです。設定で入力し直してください。',
  API_KEY_FORBIDDEN: 'この API キーには必要な権限がありません。',
  DESIGN_STRUCTURE_FAILED:
    'AI の出力を妥当な幾何設計に変換できませんでした。もう一度試すか、設定でモデルを変えてください。',
  BROWSER_CORS_BLOCKED:
    'ブラウザからプロバイダーへの直接アクセスが拒否されました。このエンドポイントは CORS を許可していない可能性があります（ローカルで `pnpm dev` を使うとサーバー経由になります）。',
}

/**
 * AI 系エラーを表示用文字列へ変換する。
 * 既知の code は日本語文言、code 無し / 未知はメッセージをそのまま返す。
 */
export function localizeAiError(err: unknown): string {
  const code = aiErrorCodeOf(err)
  if (code) return CODE_TO_MESSAGE[code]
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return '設計の生成に失敗しました。'
}

/** AI 未設定ガード発火の通知イベント。App が listen して設定モーダルを開く */
export const AI_NOT_CONFIGURED_EVENT = 'geologo-ai-not-configured'
export const OPEN_SETTINGS_EVENT = 'geologo-open-settings'

// ガード発火の連続 dispatch 抑制用タイムスタンプ
let lastGuardDispatchAt = 0

/**
 * AI 発火経路の共通ガード。モデル未登録ならリクエストを発火させず、
 * 設定画面への導線イベントを出して false を返す。
 * 使い方: `if (!ensureModelConfigured(hasModel)) return;`
 *
 * 短時間の連続発火では dispatch を 1 回に抑える（false は毎回返す）。
 */
export function ensureModelConfigured(hasModel: boolean): boolean {
  if (hasModel) return true
  const now = Date.now()
  if (now - lastGuardDispatchAt > 1500) {
    lastGuardDispatchAt = now
    window.dispatchEvent(new CustomEvent(AI_NOT_CONFIGURED_EVENT))
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))
  }
  return false
}
