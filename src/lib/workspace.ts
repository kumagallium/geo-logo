import { isTauri } from './api-base'

/**
 * 履歴フォルダ（~/Documents/geo-logo）を OS のファイルマネージャで開く。
 *
 * パスは Rust 側（open_workspace_dir）が決める。画面から任意のパスを渡す口に
 * しないため。ブラウザ版には開く手段が無いので、呼び手は isTauri() で出し分ける。
 */
export async function openWorkspaceDir(): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_workspace_dir')
}

export { isTauri }
