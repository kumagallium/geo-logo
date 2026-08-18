import { describe, expect, it } from 'vitest'
import { samples } from '../../core/index'
import {
  MAX_SESSIONS,
  SESSIONS_KEY,
  loadSessions,
  mergeSessions,
  saveSessions,
  type KV,
} from './session-store'
import type { Session } from './types'

/**
 * 履歴は再起動で消えていた。保存 → 読込で同じ会話に戻れることと、
 * 壊れた保存や容量超過で全滅しないことを見る。
 */

function memoryKV(): KV & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

const session = (id: string, n = 1, at = 1): Session => ({
  id,
  title: '',
  updatedAt: at,
  design: samples[0],
  messages: Array.from({ length: n }, (_, i) => ({
    id: `${id}-m${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `t${i}`,
    design: i % 2 === 1 ? samples[0] : undefined,
  })),
})

describe('履歴の永続化', () => {
  it('保存した会話と選択中の会話に戻れる', () => {
    const kv = memoryKV()
    saveSessions([session('b'), session('a')], 'a', kv)
    const back = loadSessions(kv)
    expect(back?.sessions.map((s) => s.id)).toEqual(['b', 'a'])
    expect(back?.activeId).toBe('a')
    expect(back?.sessions[1].messages[0].text).toBe('t0')
    expect(back?.sessions[1].design?.name).toBe(samples[0].name)
  })

  it('空の会話は保存しない。全部が空ならキーごと消す', () => {
    const kv = memoryKV()
    saveSessions([session('x', 0), session('y', 2)], 'x', kv)
    const back = loadSessions(kv)
    expect(back?.sessions.map((s) => s.id)).toEqual(['y'])
    // 選択中だった空の会話は残っていないので、選択も引き継がない
    expect(back?.activeId).toBeNull()

    saveSessions([session('x', 0)], 'x', kv)
    expect(kv.map.has(SESSIONS_KEY)).toBe(false)
    expect(loadSessions(kv)).toBeNull()
  })

  it('保存が無い・壊れているときは null', () => {
    const kv = memoryKV()
    expect(loadSessions(kv)).toBeNull()
    kv.setItem(SESSIONS_KEY, '{not json')
    expect(loadSessions(kv)).toBeNull()
    kv.setItem(SESSIONS_KEY, JSON.stringify({ v: 1, sessions: 'nope' }))
    expect(loadSessions(kv)).toBeNull()
  })

  it('壊れた要素だけ捨てて残りは活かす', () => {
    const kv = memoryKV()
    kv.setItem(
      SESSIONS_KEY,
      JSON.stringify({
        v: 1,
        activeId: 'ok',
        sessions: [
          { id: 'ok', messages: [{ id: 'm', role: 'user', text: 'hi' }, { role: 'zzz' }, 42] },
          { title: 'no id' },
          null,
        ],
      }),
    )
    const back = loadSessions(kv)
    expect(back?.sessions).toHaveLength(1)
    expect(back?.sessions[0].messages).toHaveLength(1)
    expect(back?.sessions[0].design).toBeNull()
    expect(back?.activeId).toBe('ok')
  })

  it('上限を超えた古い会話は落とす', () => {
    const kv = memoryKV()
    const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => session(`s${i}`))
    saveSessions(many, null, kv)
    expect(loadSessions(kv)?.sessions).toHaveLength(MAX_SESSIONS)
    expect(loadSessions(kv)?.sessions[0].id).toBe('s0')
  })

  it('容量超過なら古い方から落として書き直す', () => {
    const kv = memoryKV()
    const limit = JSON.stringify([session('a'), session('b')]).length + 100
    const tight: KV = {
      ...kv,
      setItem: (k, v) => {
        if (v.length > limit) throw new DOMException('quota', 'QuotaExceededError')
        kv.map.set(k, v)
      },
    }
    saveSessions([session('a'), session('b'), session('c'), session('d')], 'a', tight)
    const back = loadSessions(kv)
    expect(back?.sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(back?.activeId).toBe('a')
  })
})

describe('ファイル（サーバー）との突き合わせ', () => {
  it('サーバーが正。両方にあれば新しい方、ローカルが新しければ送る', () => {
    const local = [session('a', 1, 10), session('b', 1, 1)]
    const remote = [session('a', 3, 5), session('b', 3, 9), session('c', 1, 7)]
    const { sessions, toUpload } = mergeSessions(local, remote, 100)
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(sessions[0].messages).toHaveLength(1) // ローカルの a（新しい）
    expect(sessions[1].messages).toHaveLength(3) // サーバーの b（新しい）
    expect(toUpload.map((s) => s.id)).toEqual(['a'])
  })

  it('一度も同期していなければローカルの会話は全部送る（移行）', () => {
    const { sessions, toUpload } = mergeSessions([session('x', 1, 1)], [], 0)
    expect(sessions.map((s) => s.id)).toEqual(['x'])
    expect(toUpload.map((s) => s.id)).toEqual(['x'])
  })

  it('同期後にフォルダから消えた会話は復活させない。同期後に触った会話は送る', () => {
    const local = [session('old', 1, 50), session('new', 1, 150)]
    const { sessions, toUpload } = mergeSessions(local, [], 100)
    expect(sessions.map((s) => s.id)).toEqual(['new'])
    expect(toUpload.map((s) => s.id)).toEqual(['new'])
  })

  it('空の会話は先頭に残し、送らない', () => {
    const { sessions, toUpload } = mergeSessions(
      [session('empty', 0, 999)],
      [session('r', 1, 1)],
      0,
    )
    expect(sessions.map((s) => s.id)).toEqual(['empty', 'r'])
    expect(toUpload).toEqual([])
  })
})
