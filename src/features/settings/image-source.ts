// 画像生成器（ローカルコマンド）の設定の読み書き
//
// モデル設定（model-source.ts）と違い、サーバーモード専用。静的モード（Pages）は
// ブラウザからコマンドを実行できないので、この画面ごと出さない。

import { aiErrorFromResponse } from '../../lib/ai-error'
import { apiFetch } from '../../lib/api-base'

export type ImageGenInfo = {
  /** 未設定なら null */
  command: string | null
  size: number
  /** この環境で動く見込みの既定コマンド（サーバーが環境を見て提案）。無ければ null */
  suggestion: string | null
}

export async function getImageGen(): Promise<ImageGenInfo> {
  const res = await apiFetch('api/image/config')
  if (!res.ok) throw await aiErrorFromResponse(res, '画像生成器の設定を読めませんでした')
  return (await res.json()) as ImageGenInfo
}

/** command を空・null にすると解除 */
export async function saveImageGen(command: string | null, size?: number): Promise<void> {
  const res = await apiFetch('api/image/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, size }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, '画像生成器の設定を保存できませんでした')
}
