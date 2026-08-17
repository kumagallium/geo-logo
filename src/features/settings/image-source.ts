// 画像生成器（ローカルコマンド）の設定の読み書き
//
// モデル設定（model-source.ts）と違い、サーバーモード専用。静的モード（Pages）は
// ブラウザからコマンドを実行できないので、この画面ごと出さない。

import { aiErrorFromResponse } from '../../lib/ai-error'
import { apiFetch } from '../../lib/api-base'

export type ImageGenInfo = {
  /** 実際に使われるコマンド。使えない・切ってあるときは null */
  command: string | null
  size: number
  /** 出どころ: saved=明示保存 / env=環境変数 / auto=自動検出 / disabled=OFF / none=未検出 */
  source: 'saved' | 'env' | 'auto' | 'disabled' | 'none'
}

export async function getImageGen(): Promise<ImageGenInfo> {
  const res = await apiFetch('api/image/config')
  if (!res.ok) throw await aiErrorFromResponse(res, '画像生成器の設定を読めませんでした')
  return (await res.json()) as ImageGenInfo
}

/** ON は自動検出へ戻す。OFF は自動検出に勝つ「切った」を書き残す */
export async function setImageGenEnabled(enabled: boolean): Promise<void> {
  const res = await apiFetch('api/image/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, '画像生成の切り替えに失敗しました')
}

/** 明示コマンドの保存（高度な設定）。自動検出より優先される */
export async function saveImageGenCommand(command: string, size?: number): Promise<void> {
  const res = await apiFetch('api/image/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, size }),
  })
  if (!res.ok) throw await aiErrorFromResponse(res, '画像生成器の設定を保存できませんでした')
}
