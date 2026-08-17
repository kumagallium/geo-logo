import { useCallback, useEffect, useState } from 'react'
import { UPDATE_EVENT, checkForUpdates, type UpdateAvailableDetail } from '../lib/updater'

/**
 * 更新の案内。updater.ts が見つけたときだけ、画面の上に 1 行出す。
 *
 * バナーは確認した時点の版を持ち続けるので、表示中に次の版が出ると古い案内を
 * 出し続ける。「もう一度確認」で取り直せるようにしてある。最新に追いついて
 * いれば消える。
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateAvailableDetail | null>(null)
  const [installing, setInstalling] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: Event) => setUpdate((e as CustomEvent<UpdateAvailableDetail>).detail)
    window.addEventListener(UPDATE_EVENT, handler)
    return () => window.removeEventListener(UPDATE_EVENT, handler)
  }, [])

  const install = useCallback(async () => {
    if (!update) return
    setInstalling(true)
    setError(null)
    try {
      await update.install()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setInstalling(false)
    }
  }, [update])

  const recheck = useCallback(async () => {
    setRechecking(true)
    try {
      const r = await checkForUpdates()
      if (r.status === 'up-to-date') setUpdate(null)
    } finally {
      setRechecking(false)
    }
  }, [])

  if (!update) return null

  return (
    <div className="banner banner--update" role="status">
      <span>
        新しいバージョン <strong>v{update.version}</strong> があります
      </span>
      <button type="button" className="btn btn--primary btn--sm" onClick={install} disabled={installing}>
        {installing ? '更新しています…' : '再起動して更新'}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={recheck} disabled={rechecking || installing}>
        {rechecking ? '確認中…' : 'もう一度確認'}
      </button>
      {error && <span className="banner__error">{error}</span>}
    </div>
  )
}
