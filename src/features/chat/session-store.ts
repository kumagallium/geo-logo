// 会話履歴の永続化
//
// 履歴は React の state にしか無く、再起動・リロードで消えていた。行き来しながら
// 詰める道具なのに、翌日には戻る先が無い。
//
// 実体は 2 段:
//
//   ファイル      : サーバーが居るとき（デスクトップ版・pnpm dev）。Graphium と同じく
//                   利用者のフォルダ（~/Documents/geo-logo/sessions/*.json）に
//                   1 会話 1 ファイル。Finder から見え、バックアップも持ち運びもできる。
//   localStorage  : 静的配信（Pages）ではこれが実体。サーバーが居る環境でも
//                   **起動直後のキャッシュ**として書き続ける——デスクトップ版は
//                   同梱サーバーの起動を待たずに画面を描くので、待つ間も前回の
//                   履歴が見えるように。
//
// 2 段の突き合わせ（mergeSessions）: サーバーが正。ローカルにしか無い会話は
// 「前回の同期より後に触ったもの」だけ拾い上げてサーバーへ送る（初回は同期の
// 記録が無いので全部送る＝移行）。フォルダから消したファイルの会話は、前回の
// 同期より古いので復活しない。

import type { LogoDesign } from '../../core/index'
import { apiFetch } from '../../lib/api-base'
import type { Message, Session } from './types'

export const SESSIONS_KEY = 'geologo-sessions'
/** サーバーと最後に突き合わせた時刻（ms）。localStorage に置く */
export const SYNCED_AT_KEY = 'geologo-sessions-synced-at'
const VERSION = 1
/** 残す会話の上限。これを超えた古いものは黙って落とす */
export const MAX_SESSIONS = 100

type Stored = { v: number; activeId: string | null; sessions: Session[] }

/** テストで差し替えるための最小の窓口 */
export type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const isDesign = (x: unknown): x is LogoDesign =>
  typeof x === 'object' && x !== null && typeof (x as { name?: unknown }).name === 'string'

/** 壊れた要素は個別に捨てて、残りは活かす（全滅させない） */
function parseMessage(x: unknown): Message | null {
  if (typeof x !== 'object' || x === null) return null
  const m = x as Partial<Message>
  if (typeof m.id !== 'string' || typeof m.text !== 'string') return null
  if (m.role !== 'user' && m.role !== 'assistant') return null
  const out: Message = { id: m.id, role: m.role, text: m.text }
  if (isDesign(m.design)) out.design = m.design
  if (typeof m.reference === 'string') out.reference = m.reference
  return out
}

function parseSession(x: unknown): Session | null {
  if (typeof x !== 'object' || x === null) return null
  const s = x as Partial<Session>
  if (typeof s.id !== 'string') return null
  return {
    id: s.id,
    title: typeof s.title === 'string' ? s.title : '',
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
    messages: Array.isArray(s.messages)
      ? s.messages.map(parseMessage).filter((m): m is Message => m !== null)
      : [],
    design: isDesign(s.design) ? s.design : null,
    ...(Array.isArray(s.candidates) && s.candidates.some(isDesign)
      ? { candidates: s.candidates.filter(isDesign) }
      : {}),
  }
}

/** 保存済みの履歴。無ければ null（呼び手が新規セッションを作る） */
export function loadSessions(kv: KV | null = storage()): {
  sessions: Session[]
  activeId: string | null
} | null {
  if (!kv) return null
  try {
    const raw = kv.getItem(SESSIONS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Stored>
    if (!Array.isArray(parsed.sessions)) return null
    const sessions = parsed.sessions.map(parseSession).filter((s): s is Session => s !== null)
    if (sessions.length === 0) return null
    const activeId =
      typeof parsed.activeId === 'string' && sessions.some((s) => s.id === parsed.activeId)
        ? parsed.activeId
        : null
    return { sessions, activeId }
  } catch {
    return null
  }
}

/**
 * 空の会話（メッセージ 0 件）は保存しない。「新しい設計」を押しただけの
 * 殻が起動のたびに積み上がるのを避けるため。ただし全部が空なら何も書かない
 * のではなく、キーごと消して「保存なし」に戻す。
 */
export function saveSessions(
  sessions: Session[],
  activeId: string | null,
  kv: KV | null = storage(),
): void {
  if (!kv) return
  let keep = sessions.filter((s) => s.messages.length > 0).slice(0, MAX_SESSIONS)
  if (keep.length === 0) {
    try {
      kv.removeItem(SESSIONS_KEY)
    } catch {
      // 書けない環境では諦める
    }
    return
  }
  const active = keep.some((s) => s.id === activeId) ? activeId : null
  // 容量超過なら古い方から半分ずつ落として書き直す
  for (;;) {
    const body: Stored = { v: VERSION, activeId: active, sessions: keep }
    try {
      kv.setItem(SESSIONS_KEY, JSON.stringify(body))
      return
    } catch {
      if (keep.length <= 1) return
      keep = keep.slice(0, Math.ceil(keep.length / 2))
    }
  }
}

// --- サーバー（ファイル）経路 ---

export function loadSyncedAt(kv: KV | null = storage()): number {
  const n = Number(kv?.getItem(SYNCED_AT_KEY) ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function saveSyncedAt(at: number, kv: KV | null = storage()): void {
  try {
    kv?.setItem(SYNCED_AT_KEY, String(at))
  } catch {
    // 書けなければ次回も移行扱いになるだけ
  }
}

/** サーバーの一覧。保存先フォルダも返す（画面で示す） */
export async function fetchRemoteSessions(): Promise<{ dir: string; sessions: Session[] }> {
  const res = await apiFetch('api/sessions', { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`履歴の取得に失敗しました (${res.status})`)
  const body = (await res.json()) as { dir?: unknown; sessions?: unknown }
  const sessions = Array.isArray(body.sessions)
    ? body.sessions.map(parseSession).filter((s): s is Session => s !== null)
    : []
  return { dir: typeof body.dir === 'string' ? body.dir : '', sessions }
}

export async function putRemoteSession(session: Session): Promise<void> {
  const res = await apiFetch(`api/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(session),
  })
  if (!res.ok) throw new Error(`履歴の保存に失敗しました (${res.status})`)
}

export async function deleteRemoteSession(id: string): Promise<void> {
  const res = await apiFetch(`api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`履歴の削除に失敗しました (${res.status})`)
}

/**
 * ローカル（state / localStorage）とサーバーの突き合わせ。
 *
 * - 両方にある: updatedAt が新しい方。ローカルが新しければ送る
 * - サーバーだけ: そのまま採る
 * - ローカルだけ: syncedAt より後に触った（または一度も同期していない）会話だけ
 *   採って送る。それより古いものはフォルダから消されたとみなして落とす
 *
 * 並びはサーバーの一覧順（新しい順）を基本に、拾い上げたローカル分は
 * updatedAt で差し込む。空の会話（未着手）はローカル側だけ、先頭に残す。
 */
export function mergeSessions(
  local: Session[],
  remote: Session[],
  syncedAt: number,
): { sessions: Session[]; toUpload: Session[] } {
  const byId = new Map(remote.map((s) => [s.id, s] as const))
  const toUpload: Session[] = []
  const merged: Session[] = []
  const empties: Session[] = []

  for (const l of local) {
    if (l.messages.length === 0) {
      empties.push(l)
      continue
    }
    const r = byId.get(l.id)
    if (r) {
      if (l.updatedAt > r.updatedAt) {
        byId.set(l.id, l)
        toUpload.push(l)
      }
    } else if (syncedAt === 0 || l.updatedAt > syncedAt) {
      byId.set(l.id, l)
      toUpload.push(l)
    }
  }
  merged.push(...byId.values())
  merged.sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions: [...empties, ...merged], toUpload }
}
