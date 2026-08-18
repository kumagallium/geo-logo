// 会話履歴のファイル保存
//
// Graphium と同じく、利用者の目に見えるフォルダ（デスクトップ版は
// ~/Documents/geo-logo）へ 1 会話 1 ファイルで置く。WebView の localStorage は
// Finder から見えず、アンインストールや WebKit データの掃除で消えるので、
// 「戻れる履歴」の実体にはしない。
//
//   <workspace>/sessions/<id>.json
//
// 中身は画面の Session そのもの（設計 DSL を含む）なので、ファイル単体を
// scripts/render.ts などに渡して描き直せる。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from './models.js'

/** 起動時に GEOLOGO_WORKSPACE_DIR から入る。未指定なら data の下 */
let workspaceDir: string | null = null

export function setWorkspaceDir(dir: string): void {
  workspaceDir = dir
}

export function getWorkspaceDir(): string {
  return workspaceDir ?? join(getDataDir(), 'workspace')
}

function sessionsDir(): string {
  return join(getWorkspaceDir(), 'sessions')
}

/** ファイル名に使える id だけ通す。パス区切りや .. を含む id は拒む */
export const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,80}$/.test(id)

/** 保存する形。画面の Session と同じ。中身の妥当性は画面側の型が担う */
export type StoredSession = {
  id: string
  title: string
  updatedAt: number
  messages: unknown[]
  design: unknown
}

function isStoredSession(x: unknown): x is StoredSession {
  if (typeof x !== 'object' || x === null) return false
  const s = x as Partial<StoredSession>
  return (
    typeof s.id === 'string' &&
    isSafeId(s.id) &&
    typeof s.updatedAt === 'number' &&
    Array.isArray(s.messages)
  )
}

/** 新しい順。壊れたファイルは飛ばす（1 件のせいで全部が消えないように） */
export function listSessions(): StoredSession[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []
  const out: StoredSession[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf-8'))
      if (isStoredSession(parsed)) out.push(parsed)
    } catch (e) {
      console.warn(`[sessions] ${name} を読めません: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 1 会話を書く。書きかけで落ちても前の内容が残るよう、隣に書いてから rename する。
 */
export function saveSession(session: StoredSession): void {
  if (!isSafeId(session.id)) throw new Error(`不正な id: ${session.id}`)
  const dir = sessionsDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${session.id}.json`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf-8')
  renameSync(tmp, path)
}

export function deleteSession(id: string): boolean {
  if (!isSafeId(id)) return false
  const path = join(sessionsDir(), `${id}.json`)
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}
