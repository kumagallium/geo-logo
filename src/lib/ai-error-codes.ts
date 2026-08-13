// AI 関連エラーの機械可読コード（サーバー・クライアント共有 / 依存なし）
//
// Graphium の src/lib/ai-error-codes.ts をそのまま移植。
// サーバーは AI セットアップ・認証系のエラーレスポンスに `code` フィールドを付け、
// クライアントは code → 表示文言に変換する（src/lib/ai-error.ts の localizeAiError）。
// `error`（英語メッセージ文字列）は従来どおり保持するので、レスポンス形状は壊れない。

export const AI_ERROR_CODES = {
  /** モデルが 1 件も登録されていない（400） */
  NO_MODEL_REGISTERED: 'NO_MODEL_REGISTERED',
  /** API キーが無効か期限切れ（401） */
  INVALID_API_KEY: 'INVALID_API_KEY',
  /** API キーに権限が無い（403） */
  API_KEY_FORBIDDEN: 'API_KEY_FORBIDDEN',
  /** LLM 出力が再試行しても妥当な設計 DSL にならなかった（502）
   *  — Graphium の PROV_STRUCTURE_FAILED に対応する geo-logo 側のコード */
  DESIGN_STRUCTURE_FAILED: 'DESIGN_STRUCTURE_FAILED',
  /** ブラウザ直叩きが CORS で拒否された（静的モード固有） */
  BROWSER_CORS_BLOCKED: 'BROWSER_CORS_BLOCKED',
} as const

export type AiErrorCode = keyof typeof AI_ERROR_CODES

/**
 * code プロパティ付き Error。
 * 内部で throw し、各ルートの catch が errorBody() 経由で JSON の `code` へ通す。
 */
export class CodedError extends Error {
  readonly code: AiErrorCode
  constructor(message: string, code: AiErrorCode) {
    super(message)
    this.name = 'CodedError'
    this.code = code
  }
}

/** err から既知の AI エラーコードを取り出す（未知の code / code 無しは undefined） */
export function aiErrorCodeOf(err: unknown): AiErrorCode | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code
  // `in` はプロトタイプ鎖を通す（"toString" in {} === true）ため hasOwnProperty で判定する
  return typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(AI_ERROR_CODES, code)
    ? (code as AiErrorCode)
    : undefined
}

/** モデル未登録（400）用の共通レスポンスボディ */
export function noModelRegisteredBody(): { error: string; code: AiErrorCode } {
  return {
    error: 'No AI model is registered. Add a model in Settings.',
    code: 'NO_MODEL_REGISTERED',
  }
}

/** 設計 DSL 生成失敗（502）用の共通レスポンスボディ */
export function designStructureFailedBody(): { error: string; code: AiErrorCode } {
  return {
    error:
      'The AI output could not be turned into a valid geometric design. Try again, or switch the model in Settings.',
    code: 'DESIGN_STRUCTURE_FAILED',
  }
}

/**
 * catch した err を `{ error, code? }` ボディへ変換する。
 * code は既知のもの（AI_ERROR_CODES）だけ通し、未知の値は落とす。
 */
export function errorBody(
  err: unknown,
  fallback = 'Unknown error',
): { error: string; code?: AiErrorCode } {
  const message =
    err instanceof Error && err.message
      ? err.message
      : typeof err === 'string' && err
        ? err
        : fallback
  const code = aiErrorCodeOf(err)
  return { error: message, ...(code ? { code } : {}) }
}
