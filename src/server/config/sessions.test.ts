import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteSession,
  getWorkspaceDir,
  isSafeId,
  listSessions,
  saveSession,
  setWorkspaceDir,
} from './sessions'

/**
 * 履歴は利用者のフォルダに 1 会話 1 ファイル。特に **setWorkspaceDir で保存先を
 * 差し替えられる**こと（デスクトップ版は ~/Documents/geo-logo を渡す）と、
 * 壊れたファイル 1 件で一覧が全滅しないことを固定する。
 */

describe('履歴のファイル保存', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geologo-sessions-'))
    setWorkspaceDir(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('差し替え先の sessions/<id>.json に書き、新しい順で読める', () => {
    expect(getWorkspaceDir()).toBe(dir)
    saveSession({ id: 'a', title: '', updatedAt: 1, messages: [{ text: 'x' }], design: null })
    saveSession({ id: 'b', title: 't', updatedAt: 2, messages: [], design: { name: 'd' } })
    expect(existsSync(join(dir, 'sessions', 'a.json'))).toBe(true)
    // 書きかけの tmp は残らない
    expect(existsSync(join(dir, 'sessions', 'a.json.tmp'))).toBe(false)
    expect(listSessions().map((s) => s.id)).toEqual(['b', 'a'])
    expect(JSON.parse(readFileSync(join(dir, 'sessions', 'b.json'), 'utf-8')).design).toEqual({
      name: 'd',
    })
  })

  it('壊れたファイルは飛ばし、他は読める', () => {
    saveSession({ id: 'ok', title: '', updatedAt: 1, messages: [], design: null })
    writeFileSync(join(dir, 'sessions', 'broken.json'), '{nope')
    writeFileSync(join(dir, 'sessions', 'wrong.json'), JSON.stringify({ id: 'wrong' }))
    expect(listSessions().map((s) => s.id)).toEqual(['ok'])
  })

  it('パスに化ける id は拒む', () => {
    expect(isSafeId('s-1787012499836-1')).toBe(true)
    expect(isSafeId('../etc/passwd')).toBe(false)
    expect(isSafeId('a/b')).toBe(false)
    expect(isSafeId('')).toBe(false)
    expect(() =>
      saveSession({ id: '../x', title: '', updatedAt: 1, messages: [], design: null }),
    ).toThrow()
    expect(deleteSession('../x')).toBe(false)
  })

  it('削除できる。無いものは false', () => {
    saveSession({ id: 'a', title: '', updatedAt: 1, messages: [], design: null })
    expect(deleteSession('a')).toBe(true)
    expect(deleteSession('a')).toBe(false)
    expect(listSessions()).toEqual([])
  })

  it('フォルダがまだ無ければ空', () => {
    setWorkspaceDir(join(dir, 'nowhere'))
    expect(listSessions()).toEqual([])
  })
})

describe('候補の保存', () => {
  /**
   * 候補は「選ぶために並べたもの」なので、選び終えるまで残らないと用を成さない。
   * ファイルに書かないと localStorage にしか残らず、フォルダの履歴と突き合わせた
   * 時点で消える（実測: 保存された会話に candidates が入っていなかった）。
   */
  it('candidates を書いて読み戻せる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geologo-sess-'))
    setWorkspaceDir(dir)
    try {
      saveSession({
        id: 's-1',
        title: 't',
        updatedAt: 1,
        messages: [],
        design: null,
        candidates: [{ name: 'a' }, { name: 'b' }],
      })
      const back = listSessions()[0] as { candidates?: unknown[] }
      expect(back.candidates).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
