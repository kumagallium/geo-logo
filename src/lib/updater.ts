import pkg from '../../package.json'
import { isTauri } from './api-base'

/**
 * デスクトップ版の自動更新。
 *
 * 起動時と 24 時間ごとに確認し、更新があれば CustomEvent で UI に知らせる。
 * 設定画面の「このアプリについて」から手で確認することもできる。
 * Graphium の同名モジュールと同じ作り。
 *
 * ブラウザ（Pages）では何もしない。更新は配信側の仕事なので確認する意味がない。
 */

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export const UPDATE_EVENT = 'geo-logo-update-available'

/**
 * 直近の確認で見つかった更新。
 *
 * イベントは 1 回きりなので、あとから開いた画面（設定 → アプリ情報）は取り逃がす。
 * 起動時の自動確認で見つかっていれば、設定を開いた時点で「再起動して更新」を
 * 出せるように、最後の結果をここに残す。
 */
let pending: UpdateAvailableDetail | null = null

/** 見つかっている更新。無ければ null */
export function getPendingUpdate(): UpdateAvailableDetail | null {
  return pending
}

/** 更新が見つかったときに UI へ渡すもの */
export type UpdateAvailableDetail = {
  version: string
  /** ダウンロードして入れ替え、再起動する */
  install: () => Promise<void>
}

/** 手で確認したときの結果 */
export type CheckResult =
  | { status: 'unsupported' }
  | { status: 'up-to-date' }
  | { status: 'available'; version: string }
  | { status: 'error'; message: string }

/** デスクトップ版なら本物のバージョン、それ以外は package.json のもの */
export async function getAppVersion(): Promise<string> {
  if (isTauri()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      return await getVersion()
    } catch {
      // 取れなければ package.json へ倒す
    }
  }
  return pkg.version
}

/** 起動時に 1 回呼ぶ。5 秒待つのは初期表示を邪魔しないため */
export function initUpdater(): void {
  if (!isTauri()) return
  setTimeout(() => void checkForUpdates(), 5000)
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

/** 更新を確認する。見つかれば UPDATE_EVENT も発火する。 */
export async function checkForUpdates(): Promise<CheckResult> {
  if (!isTauri()) return { status: 'unsupported' }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      pending = null
      return { status: 'up-to-date' }
    }

    const detail: UpdateAvailableDetail = {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall()
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      },
    }
    pending = detail
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail }))
    return { status: 'available', version: update.version }
  } catch (e) {
    // updater が未設定（公開鍵の不一致・配信先が無い）か、ネットワークの失敗
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}
