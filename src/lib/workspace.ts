import { isTauri } from './api-base'

/**
 * 保存先フォルダ（会話履歴と設計の置き場）の操作。デスクトップ版だけ。
 *
 * 実体は Tauri 側が `<OS の設定ディレクトリ>/com.geologo.app/config.json` に持ち、
 * サイドカーの起動時に GEOLOGO_WORKSPACE_DIR として渡される。Graphium の
 * graphium-root.ts と同じ役割で、名前だけ geo-logo に合わせたもの。
 *
 * **反映には再起動が要る。** 保存先はサイドカーの起動時に渡されるので、動いている
 * サーバーは古い場所を掴んだままになる。UI は変更後に再起動を促す。
 */

export type WorkspaceRootInfo = {
  /** いま使われている絶対パス */
  current: string
  /** 未設定時の既定パス（~/Documents/geo-logo） */
  defaultRoot: string
  /** 利用者が既定以外を指定しているか */
  isCustom: boolean
}

async function invokeCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(name, args)
}

export async function getWorkspaceRoot(): Promise<WorkspaceRootInfo> {
  return invokeCommand<WorkspaceRootInfo>('get_workspace_root')
}

/** 保存先を決める。null で既定に戻す */
export async function setWorkspaceRoot(path: string | null): Promise<WorkspaceRootInfo> {
  return invokeCommand<WorkspaceRootInfo>('set_workspace_root', { path })
}

/** フォルダ選択ダイアログ。選ばれなければ null */
export async function pickWorkspaceRoot(): Promise<string | null> {
  return (await invokeCommand<string | null>('pick_workspace_root')) ?? null
}

/**
 * 履歴フォルダを OS のファイルマネージャで開く。
 *
 * パスは Rust 側（open_workspace_dir）が決める。画面から任意のパスを渡す口に
 * しないため。ブラウザ版には開く手段が無いので、呼び手は isTauri() で出し分ける。
 */
export async function openWorkspaceDir(): Promise<void> {
  if (!isTauri()) return
  await invokeCommand('open_workspace_dir')
}

/** 変更を反映するためにアプリを再起動する */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}

export { isTauri }
